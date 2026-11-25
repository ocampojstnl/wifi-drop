// How this tab meets the other devices on its network, with no account or server of our own:
//
//  1. The site gives this visitor its network's secret room name and password (/api/room, see lib/room.mjs).
//  2. Trystero finds the other devices in that room through free public relays (Nostr). Only a short "here's how to
//     reach me" note passes through them, encrypted with the room's password: the relays can't read it.
//  3. Then every device is connected DIRECTLY to every other. Everything below travels over those direct
//     connections, never through the relays: who is here, names, the files on offer, private file lists, access
//     requests, and the set-up messages for each file transfer. The files themselves go device to device too
//     (see app.js). Nothing about a file ever reaches a server.
//  4. Before trusting a device, this tab checks that the direct connection really runs over the local network
//     (lan.js). One that's somewhere else (same public address, different home) is ignored: it sees nothing.
//
// Each browser has a lasting identity Trystero keeps for it (the same in all its tabs; a private window gets a new
// one), signed so that no other device can pose as it. A tab's id is "<device>~<tab>".
import { joinRoom, getRelaySockets } from "/static/vendor/trystero.js";
import { checkConnection } from "/static/lan.js";

const MAX_LISTED = 60; // files listed per tab
const KINDS = new Set(["pc", "phone", "tablet"]);
const tabId = (userId, peerId) => `${userId}~${peerId}`;
const peerOf = (tab = "") => tab.split("~")[1];
const slim = (o) => ({ fid: String(o.fid).slice(0, 40), name: String(o.name ?? "file").slice(0, 120), size: Math.max(0, Number(o.size) || 0), type: String(o.type ?? "").slice(0, 60) });
const RELAYS = 10; // relays used at once to find each other (Trystero's default is 5); any one of them is enough

/**
 * This network's public IPv4 address, as a STUN helper sees it (or "" if there's none, or it takes too long).
 * Phones and computers on one Wi-Fi may reach the site over IPv6 or IPv4; this lets them all land in the same room.
 */
function publicIPv4(iceServers, ms = 4000) {
  return new Promise((resolve) => {
    let pc;
    const done = (ip = "") => { clearTimeout(timer); try { pc?.close(); } catch {} resolve(ip); };
    const timer = setTimeout(done, ms);
    try {
      pc = new RTCPeerConnection({ iceServers: iceServers.filter((s) => [].concat(s.urls).some((u) => /^stuns?:/.test(u))) });
      pc.createDataChannel("probe");
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return done();
        const m = / (\d+\.\d+\.\d+\.\d+) \d+ typ srflx/.exec(candidate.candidate);
        if (m) done(m[1]);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done());
    } catch { done(); }
  });
}

const cleanList = (list) => (Array.isArray(list) ? list.slice(0, MAX_LISTED).map((o) => ({ ...slim(o), access: Number(o.access) || null, reshare: !!o.reshare })) : []);

/**
 * Join this network's room.
 *   onHello({ id, did })                 in the room
 *   onDevices(list)                      the devices here (one entry per device, however many tabs) and what they offer
 *   onSignal({ from, data })             a transfer set-up message from another tab
 *   onGrant({ fid, add, fromDid, by })   someone asks to give others access to one of this tab's private files
 *   onOnline(boolean)                    connected to the relays (needed only to find devices that arrive later)
 */
export async function connect({ profile, iceServers, onHello, onDevices, onSignal, onGrant, onOnline }) {
  // Learned once per tab (it takes a moment) and remembered across its pages.
  let ipv4 = "";
  try { ipv4 = sessionStorage.getItem("wifi-drop:v4") || ""; } catch {}
  if (!ipv4) { ipv4 = await publicIPv4(iceServers); try { if (ipv4) sessionStorage.setItem("wifi-drop:v4", ipv4); } catch {} }
  const res = await fetch("/api/room" + (ipv4 ? "?v4=" + encodeURIComponent(ipv4) : ""), { cache: "no-store" });
  if (!res.ok) throw new Error("Couldn't reach Wi-Fi Drop");
  const { room: roomId, password } = await res.json();

  // One namespace for every address the site is opened on (localhost, the PC's network address, the live domain):
  // the secret room name is what keeps networks apart.
  const room = joinRoom({ appId: "wifi-drop.v1", password, rtcConfig: { iceServers }, relayConfig: { redundancy: RELAYS } }, roomId);
  const self = await room.getSelf();
  const did = self.userId;
  const myId = tabId(did, self.peerId);

  const profiles = room.makeAction("profile"); // name, phone/computer, files shared with everyone
  const privates = room.makeAction("private"); // files shared with one device only: sent to that device alone
  const signals = room.makeAction("signal"); // file-transfer set-up
  const grants = room.makeAction("grant"); // "give these devices access too"

  let me = { ...profile, offers: [] }; // this tab, and every file it shares (with who may have it)
  const peers = new Map(); // peerId → { userId, profile, lan: true (same network) | false (not) | null (checking) }
  const privateFrom = new Map(); // peerId → files it shares with this device only
  const sentPrivate = new Map(); // peerId → the private list last sent to it

  const publicProfile = () => ({ name: me.name, named: !!me.named, kind: me.kind, offers: me.offers.filter((o) => !o.to).slice(0, MAX_LISTED).map(slim) });
  const privateFor = (userId) => me.offers.filter((o) => o.to?.includes(userId)).map((o) => ({ ...slim(o), access: o.to.length, reshare: !!o.reshare }));
  /** Each tab's private list: only the files shared with its device, and only to it. */
  const trusted = (peerId) => peers.get(peerId)?.lan === true;
  const trustedIds = () => [...peers.keys()].filter(trusted);
  /** This tab's name and public files, to every same-network tab (or just one). */
  function sendProfile(target = trustedIds()) {
    if (Array.isArray(target) && !target.length) return Promise.resolve();
    return profiles.send(publicProfile(), { target }).catch(() => {});
  }
  function sendPrivate(peerId) {
    const p = peers.get(peerId);
    if (!p || p.userId === did || !trusted(peerId)) return;
    const list = privateFor(p.userId);
    const json = JSON.stringify(list);
    if ((sentPrivate.get(peerId) ?? "[]") === json) return;
    sentPrivate.set(peerId, json);
    privates.send({ offers: list }, { target: peerId }).catch(() => {});
  }

  let devices = [];
  function rebuild() {
    const map = new Map();
    const add = (userId, peerId, data) => {
      let dev = map.get(userId);
      if (!dev) map.set(userId, (dev = { id: tabId(userId, peerId), did: userId, name: data.name || "Device", kind: KINDS.has(data.kind) ? data.kind : "pc", tabs: [], offers: [], named: !!data.named }));
      if (data.named && !dev.named) Object.assign(dev, { name: data.name, named: true }); // a chosen name beats a default
      dev.tabs.push(tabId(userId, peerId));
      for (const o of data.offers ?? []) dev.offers.push({ ...o, owner: tabId(userId, peerId), private: false, access: null, reshare: false });
      for (const o of privateFrom.get(peerId) ?? []) dev.offers.push({ ...o, owner: tabId(userId, peerId), private: true });
    };
    add(did, self.peerId, publicProfile());
    for (const [peerId, p] of peers) if (p.profile && p.lan) add(p.userId, peerId, p.profile);
    devices = [...map.values()].map(({ named, ...dev }) => dev);
    onDevices(devices);
  }
  const nameOf = (userId) => devices.find((d) => d.did === userId)?.name ?? "A device";

  /**
   * The same-network check (see lan.js). Other tabs of this browser are this device: always trusted. Others are
   * checked a few times while the connection settles; only a clear "same network" lets them in.
   */
  async function verify(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    let verdict = p.userId === did ? true : null;
    for (let i = 0; verdict === null && i < 8 && peers.get(peerId) === p; i++) {
      if (i) await new Promise((r) => setTimeout(r, 750));
      verdict = await checkConnection(room.getPeers()[peerId]?.connection).catch(() => null);
    }
    if (peers.get(peerId) !== p) return; // it left meanwhile
    p.lan = verdict !== false; // no clear sign it is elsewhere: same home address, so trusted
    if (!p.lan) { console.info("Wi-Fi Drop: ignoring a device that isn't on this network"); return; }
    sendProfile(peerId);
    sentPrivate.delete(peerId);
    sendPrivate(peerId);
    rebuild();
  }

  room.onPeerJoin(({ peerId, userId }) => {
    peers.set(peerId, { userId, profile: peers.get(peerId)?.profile ?? null, lan: null });
    verify(peerId);
  });
  room.onPeerLeave(({ peerId }) => {
    peers.delete(peerId);
    privateFrom.delete(peerId);
    sentPrivate.delete(peerId);
    rebuild();
  });
  profiles.onMessage((data, { peerId, userId }) => {
    const d = data ?? {};
    let p = peers.get(peerId);
    if (p && p.userId !== userId) return;
    if (!p) peers.set(peerId, (p = { userId, profile: null, lan: null }));
    // Updated in place: a check still running for this peer (verify) keeps the same entry.
    p.profile = { name: String(d.name ?? "Device").slice(0, 32), named: !!d.named, kind: d.kind, offers: Array.isArray(d.offers) ? d.offers.slice(0, MAX_LISTED).map(slim) : [] };
    rebuild();
  });
  privates.onMessage((data, { peerId }) => {
    if (!trusted(peerId)) return;
    privateFrom.set(peerId, cleanList(data?.offers));
    rebuild();
  });
  signals.onMessage((data, { peerId, userId }) => trusted(peerId) && onSignal({ from: tabId(userId, peerId), data }));
  grants.onMessage((data, { peerId, userId }) => {
    if (!trusted(peerId)) return;
    onGrant({ fid: String(data?.fid ?? ""), add: Array.isArray(data?.add) ? data.add.map(String) : [], fromDid: userId, by: nameOf(userId) });
  });

  // "Online" = in touch with at least one relay (needed to meet devices that arrive later; the ones already found
  // stay connected directly even if every relay goes quiet).
  let online = null;
  const checkOnline = () => {
    const on = Object.values(getRelaySockets()).some((ws) => ws.readyState === 1);
    if (on !== online) { online = on; onOnline(on); }
  };
  checkOnline();
  setInterval(checkOnline, 2000);

  onHello({ id: myId, did });
  rebuild();

  return {
    /** What this tab shares (each file: everyone, or the devices in `to`). */
    async setOffers(offers) {
      me.offers = offers;
      await sendProfile();
      for (const peerId of peers.keys()) sendPrivate(peerId);
      rebuild();
    },
    async setName(name, named = true) {
      me = { ...me, name, named };
      await sendProfile();
      rebuild();
    },
    signal(toTab, data) {
      if (!trusted(peerOf(toTab))) return Promise.resolve();
      return signals.send(data, { target: peerOf(toTab) }).catch((e) => console.warn("signal", e));
    },
    /** Ask the tab that holds a private file to give other devices access too (it decides, see app.js). */
    grant(ownerTab, fid, add) {
      if (!trusted(peerOf(ownerTab))) return Promise.resolve();
      return grants.send({ fid, add }, { target: peerOf(ownerTab) });
    },
    /** The tab is closing: leave now, so its files disappear from every device at once. */
    leave() {
      room.leave().catch(() => {});
    },
  };
}
