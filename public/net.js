// How this tab meets the other devices on its network: a room on Ably (a live-messaging service), which only the
// devices behind the same home internet connection can enter (the site's /api/token decides, see lib/room.mjs).
//
// What goes through the room: who is here (name, phone or computer), the names and sizes of the files they share,
// and the small messages two devices exchange to open a direct connection. Files never do: they go straight from
// one device to the other, over that direct connection (see app.js).
//
//   room:<id>                presence: each tab, with its device's name and its public file list
//   room:<id>:inbox:<device> messages for one device: connection set-up, private file lists, access requests
//
// A tab's id is "<device>~<tab>": the device part is given by the site from a secret this browser keeps, so nobody
// can pose as another device. Ably attaches it to everything a tab sends; it can't be faked either.

/* global Ably */

const MAX_LISTED = 60; // files listed per tab (a room message has a size limit)
const deviceOf = (clientId = "") => clientId.split("~")[0];
const slim = (o) => ({ fid: o.fid, name: String(o.name).slice(0, 120), size: o.size, type: String(o.type ?? "").slice(0, 60) });

async function pass(device, tab) {
  const res = await fetch(`/api/token?device=${encodeURIComponent(device)}&tab=${encodeURIComponent(tab)}`, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Couldn't reach Wi-Fi Drop");
  return body;
}

/**
 * Join this network's room.
 *   onHello({ id, did })        in the room
 *   onDevices(list)             the devices here (one entry per device, however many tabs), with what they offer
 *   onSignal({ from, data })    a connection message from another tab
 *   onGrant({ fid, add, fromDid, by })  someone asks to give others access to one of this tab's private files
 *   onOnline(boolean)
 */
export async function connect({ device, tab, profile, onHello, onDevices, onSignal, onGrant, onOnline }) {
  let first = await pass(device, tab);
  const { room, did, clientId } = first;
  const ably = new Ably.Realtime({
    authCallback: (_params, done) => {
      if (first) { const t = first.tokenRequest; first = null; return done(null, t); }
      pass(device, tab).then((p) => done(null, p.tokenRequest), (e) => done(e.message, null));
    },
    closeOnUnload: false, // moving to another page isn't leaving: the room keeps this tab for a few seconds
  });
  const lobby = ably.channels.get(`room:${room}`);
  const inboxOf = (d) => ably.channels.get(`room:${room}:inbox:${d}`);
  const myInbox = inboxOf(did);

  let me = { ...profile, offers: [] }; // this tab: name, named, kind, and every file it shares (with who may have it)
  const privateFrom = new Map(); // tab id → the private files it shares with this device
  const sentPrivate = new Map(); // device → the list last sent to it (to send only changes)
  let devices = [];

  /** Files this tab shares with one device only (or a few): sent to that device's inbox, never to the room. */
  function privateFor(d) {
    return me.offers.filter((o) => o.to?.includes(d)).map((o) => ({ ...slim(o), access: o.to.length, reshare: !!o.reshare }));
  }
  async function sendPrivate(force = false) {
    const recipients = new Set([...sentPrivate.keys(), ...me.offers.flatMap((o) => o.to ?? [])]);
    for (const d of recipients) {
      if (d === did) continue;
      const list = privateFor(d);
      const json = JSON.stringify(list);
      if (!force && sentPrivate.get(d) === json) continue;
      if (list.length) sentPrivate.set(d, json); else sentPrivate.delete(d);
      await inboxOf(d).publish("private", { offers: list }).catch(() => {});
    }
  }

  async function rebuild() {
    const members = await lobby.presence.get().catch(() => []);
    const map = new Map();
    for (const m of members) {
      const d = deviceOf(m.clientId);
      const data = m.data ?? {};
      let dev = map.get(d);
      if (!dev) map.set(d, (dev = { id: m.clientId, did: d, name: data.name || "Device", kind: data.kind || "pc", tabs: [], offers: [], named: !!data.named }));
      if (data.named && !dev.named) Object.assign(dev, { name: data.name, named: true }); // a chosen name beats a default
      if (!dev.tabs.includes(m.clientId)) dev.tabs.push(m.clientId);
      for (const o of data.offers ?? []) dev.offers.push({ ...o, owner: m.clientId, private: false, access: null, reshare: false });
      for (const o of privateFrom.get(m.clientId) ?? []) dev.offers.push({ ...o, owner: m.clientId, private: true });
    }
    devices = [...map.values()].map(({ named, ...dev }) => dev);
    onDevices(devices);
  }
  const nameOf = (id) => devices.find((d) => d.tabs.includes(id) || d.did === deviceOf(id))?.name ?? "A device";

  await myInbox.subscribe((msg) => {
    const data = msg.data ?? {};
    if (msg.name === "private") {
      privateFrom.set(msg.clientId, Array.isArray(data.offers) ? data.offers.slice(0, MAX_LISTED) : []);
      rebuild();
    } else if (msg.name === "signal" && data.to === clientId) {
      onSignal({ from: msg.clientId, data: data.data });
    } else if (msg.name === "grant" && data.to === clientId) {
      onGrant({ fid: data.fid, add: Array.isArray(data.add) ? data.add : [], fromDid: deviceOf(msg.clientId), by: nameOf(msg.clientId) });
    }
  });
  await lobby.presence.subscribe((ev) => {
    // A new tab of a device this tab shares private files with: send it the list too.
    if (ev.action === "enter" && sentPrivate.has(deviceOf(ev.clientId))) {
      inboxOf(deviceOf(ev.clientId)).publish("private", { offers: privateFor(deviceOf(ev.clientId)) }).catch(() => {});
    }
    if (ev.action === "leave") privateFrom.delete(ev.clientId);
    rebuild();
  });

  const presence = () => ({ name: me.name, named: !!me.named, kind: me.kind, offers: me.offers.filter((o) => !o.to).slice(0, MAX_LISTED).map(slim) });
  await lobby.presence.enter(presence());
  ably.connection.on((change) => {
    onOnline(change.current === "connected");
    if (change.current === "connected" && change.previous !== "initialized") sendPrivate(true); // back after a drop
  });
  onOnline(ably.connection.state === "connected");
  onHello({ id: clientId, did });
  rebuild();

  return {
    /** What this tab shares (each file: everyone, or the devices in `to`). */
    async setOffers(offers) {
      me.offers = offers;
      await lobby.presence.update(presence()).catch(() => {});
      await sendPrivate();
    },
    async setName(name, named = true) {
      me = { ...me, name, named };
      await lobby.presence.update(presence()).catch(() => {});
    },
    signal(toTab, data) {
      return inboxOf(deviceOf(toTab)).publish("signal", { to: toTab, data }).catch((e) => console.warn("signal", e));
    },
    /** Ask the tab that holds a private file to give other devices access too (it decides, see app.js). */
    grant(ownerTab, fid, add) {
      return inboxOf(deviceOf(ownerTab)).publish("grant", { to: ownerTab, fid, add });
    },
    /** The tab is closing: leave the room now, so the files disappear from every device at once. */
    leave() {
      try { ably.close(); } catch {}
    },
  };
}
