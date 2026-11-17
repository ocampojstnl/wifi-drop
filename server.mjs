// Wi-Fi Drop: send files between this PC and your phone over your home Wi-Fi, directly.
// npm start, then open the page on any device on the same Wi-Fi (the QR on the PC's page is a shortcut).
//
// Files never pass through here and are never saved here: they go straight from one browser to the other
// (WebRTC). This app only serves the page and introduces the devices to each other (a few small messages).
// Every device on the home network is welcome; anything from outside it is refused.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4040;
const PUBLIC = path.join(ROOT, "public");

// A random value made once and kept: it makes the device fingerprints in the device list ("another tab on this
// device") unguessable. It no longer guards the page: everyone on the home network may come in.
const keyFile = path.join(ROOT, ".key");
const KEY = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : crypto.randomBytes(9).toString("base64url");
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, KEY);

// Google AdSense settings, read on each page load so edits apply without a restart. See ads.json.
const adsFile = path.join(ROOT, "ads.json");
function adsConfig() {
  try {
    const a = JSON.parse(fs.readFileSync(adsFile, "utf8"));
    const slots = {};
    for (const k of ["ad1", "ad2", "ad3", "ad4"]) slots[k] = String(a.slots?.[k] ?? "").trim();
    return { client: String(a.client ?? "").trim(), slots, preview: a.preview === true };
  } catch {
    return null;
  }
}

// ── Network ────────────────────────────────────────────────────────────────────────────────────────────────

/** This PC's addresses on the home network, the likeliest (Wi-Fi, 192.168.x) first. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      // Virtual adapters (WSL, Hyper-V, VirtualBox, VPNs) aren't where the phone is.
      const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Docker/i.test(name);
      const score = (a.address.startsWith("192.168.") ? 4 : a.address.startsWith("10.") ? 2 : 1) + (/wi-?fi|wlan|wireless/i.test(name) ? 4 : 0) - (virtual ? 10 : 0);
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Home network only: requests from any address outside it (the internet, a mobile network) are refused outright,
 * even if the router were set to forward this port. 10.x, 172.16–31.x, 192.168.x, this PC, and link-local.
 */
const fromHomeNetwork = (req) => isHomeIp(req.socket.remoteAddress ?? "");
function isHomeIp(address) {
  const ip = address.replace(/^::ffff:/, "");
  if (ip === "::1" || /^f[cd]|^fe[89ab]/i.test(ip)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const phoneLink = (address) => `http://${address}:${PORT}/`;

// ── Other computers running Wi-Fi Drop on this network ─────────────────────────────────────────────────────
//
// Each copy announces itself on the home network (a small UDP broadcast every 2 s, never beyond the router).
// They all join the one that started first, the host: every device on the network then sees every other one.
// If the host goes away, the next one takes over.

const DISCOVERY = process.env.DISCOVERY !== "off";
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT) || 4041;
const SELF = { id: crypto.randomBytes(6).toString("base64url"), started: Date.now() };
/** id → { ip, port, started, key, name, seen } */
const instances = new Map();
/** The copy this one has joined, or null when this one is the host. */
let hub = null;

/** Where to send a browser so it joins the host. A browser on this PC also learns its way back here. */
const hubUrl = (local) =>
  `http://${hub.ip}:${hub.port}/` + (local ? `?home=${PORT}&name=${encodeURIComponent(os.hostname())}` : "");

function electHub() {
  let best = { id: SELF.id, started: SELF.started };
  for (const [id, i] of instances) if (i.started < best.started || (i.started === best.started && id < best.id)) best = { id, ...i };
  const before = hub?.id ?? null;
  hub = best.id === SELF.id ? null : best;
  if ((hub?.id ?? null) === before) return;
  if (hub) {
    console.log(`  ↪ Joined Wi-Fi Drop on ${hub.name} (${hub.ip}:${hub.port}): devices here see everything there too.`);
    // Anyone already on this copy moves over to the host.
    for (const p of peers.values()) event(p.res, "moveto", { url: hubUrl(p.local) });
  } else {
    console.log("  This PC is hosting Wi-Fi Drop for the network.");
  }
}

function broadcastTargets() {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.netmask || !isHomeIp(a.address)) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join("."));
    }
  }
  return [...out];
}

function startDiscovery() {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const announce = () => {
    const msg = Buffer.from(JSON.stringify({ app: "wifi-drop", v: 1, id: SELF.id, port: PORT, started: SELF.started, key: KEY, name: os.hostname() }));
    for (const to of broadcastTargets()) sock.send(msg, DISCOVERY_PORT, to, () => {});
  };
  sock.on("error", (e) => {
    console.log(`  (Finding other computers is off: ${e.message})`);
    try { sock.close(); } catch {}
  });
  sock.on("message", (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (m?.app !== "wifi-drop" || m.id === SELF.id || !isHomeIp(rinfo.address)) return;
    if (typeof m.id !== "string" || m.id.length > 20 || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
    if (typeof m.started !== "number" || typeof m.key !== "string" || !/^[\w-]{1,64}$/.test(m.key)) return;
    const isNew = !instances.has(m.id);
    instances.set(m.id, { ip: rinfo.address, port: m.port, started: m.started, key: m.key, name: String(m.name ?? "a computer").slice(0, 64), seen: Date.now() });
    if (isNew) {
      console.log(`  • Found Wi-Fi Drop on ${instances.get(m.id).name} (${rinfo.address}:${m.port})`);
      announce(); // so it finds this one straight away too
    }
    electHub();
  });
  sock.bind(DISCOVERY_PORT, () => {
    sock.setBroadcast(true);
    announce();
    setInterval(announce, 2000).unref();
    setInterval(() => {
      let changed = false;
      for (const [id, i] of instances) {
        if (Date.now() - i.seen > 7000) {
          instances.delete(id);
          changed = true;
          console.log(`  • Wi-Fi Drop on ${i.name} is gone`);
        }
      }
      if (changed) electHub();
    }, 2000).unref();
  });
  sock.unref();
}
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

const safeEqual = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ── Devices: who's here, and what each one offers (names and sizes only) ───────────────────────────────────

/** id → { secret, name, kind, offers, res, local, ip, host } */
const peers = new Map();

// A device between two pages has no line for a moment: what it misses, it catches up on when it's back.
const event = (res, name, data) => res?.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
/**
 * The device list as one viewer may see it: ONE entry per device, however many tabs, browsers or private windows
 * it has open (they're told apart by device, below). Each file says which tab holds it (owner), to ask that tab.
 * A file shared with particular devices only is listed to those devices: nobody else learns it exists. (The
 * device that has the file checks again before sending it.)
 */
function publicPeers(viewer) {
  const devices = new Map(); // did → entry
  for (const [id, p] of peers) {
    let d = devices.get(p.did);
    if (!d) devices.set(p.did, (d = { id, did: p.did, name: p.name, kind: p.kind, tabs: [], offers: [], named: p.named }));
    if (p.named && !d.named) Object.assign(d, { name: p.name, named: true }); // a name someone chose beats the default
    d.tabs.push(id);
    for (const o of p.offers) {
      if (o.to && p.did !== viewer.did && !o.to.includes(viewer.did)) continue;
      // Who else has access isn't shown: only how many, and whether this viewer may give others access too.
      const { to, reshare, ...rest } = o;
      d.offers.push({ ...rest, owner: id, private: !!to, access: to ? to.length : null, reshare: !!to && reshare });
    }
  }
  return [...devices.values()].map(({ named, ...d }) => d);
}
let peersTimer = null;
function peersChanged() {
  clearTimeout(peersTimer);
  peersTimer = setTimeout(() => {
    for (const p of peers.values()) event(p.res, "peers", publicPeers(p));
  }, 50);
}

/** This PC's own addresses: a browser on this PC is this PC, whether it came in as localhost or by its Wi-Fi address. */
function ownAddresses() {
  const out = new Set(["127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address);
  return out;
}
const remoteIp = (req) => (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
const isThisPc = (req) => isLocal(req) || ownAddresses().has(remoteIp(req));

/**
 * Which device a tab is on. Every tab, browser and private window on one phone or computer comes from the same
 * address on the home network, so they all get the same id and count as one device. The id is made from the
 * address (and this app's random value, so it can't be worked out from outside); a page can't pick or fake it.
 * It stays the same across reloads, so a file shared with a device still finds it.
 */
const deviceKey = (req) =>
  crypto.createHash("sha256").update(`${KEY}|device|${isThisPc(req) ? "this-pc" : remoteIp(req)}`).digest("base64url").slice(0, 16);
// Pings keep the line open and, with TCP keep-alive, reveal a phone that dropped off the Wi-Fi without saying so
// (screen off, out of range), so it stops showing as a device you can download from.
setInterval(() => { for (const p of peers.values()) p.res?.write(": ping\n\n"); }, 10000).unref();

/** A message from a device, checked against the secret it was given when it joined. */
function sender(body) {
  const p = peers.get(body?.id);
  return p && safeEqual(body.secret, p.secret) ? p : null;
}

/**
 * Browsers hide their address behind a made-up name ("1f2e….local") that the other device has to look up on the
 * network, and on many Windows PCs and Android phones that lookup is slow or fails: the devices then barely
 * connect. This app knows each device's real address on the home network (it saw it connect), so it puts that in
 * the connection set-up messages instead. Only those messages: files never come here.
 */
function withRealAddress(data, from, to) {
  // The PC's own page connects as localhost: for the phone, the PC is the address the phone reached it on.
  const address = from.local ? (to.local ? null : to.host) : from.ip;
  if (!address || !/^[\d.]+$/.test(address)) return data;
  const swap = (text) => text.replace(/\b[\w-]+\.local(?= \d+ typ )/g, address);
  if (data?.c?.candidate) return { ...data, c: { ...data.c, candidate: swap(data.c.candidate) } };
  if (data?.sdp?.sdp) return { ...data, sdp: { ...data.sdp, sdp: swap(data.sdp.sdp) } };
  return data;
}

const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);

const cleanOffer = (o) => ({
  fid: String(o.fid ?? "").slice(0, 40),
  name: String(o.name ?? "file").slice(0, 200),
  size: Math.max(0, Number(o.size) || 0),
  type: String(o.type ?? "").slice(0, 100),
  // Only for these devices (their lasting ids), or for everyone (null).
  to: Array.isArray(o.to) ? [...new Set(o.to.filter((d) => typeof d === "string" && /^[\w-]{16}$/.test(d)))].slice(0, 50) : null,
  // Whether the devices with access may give it to others as well.
  reshare: o.reshare !== false,
});

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

const send = (res, status, body, type = "text/plain; charset=utf-8", extra = {}) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
};
const json = (res, status, data) => send(res, status, JSON.stringify(data), "application/json");

async function serveStatic(res, file) {
  const p = path.join(PUBLIC, file);
  if (!p.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
  try {
    send(res, 200, await fsp.readFile(p), TYPES[path.extname(p)] ?? "application/octet-stream", { "cache-control": "no-cache" });
  } catch {
    send(res, 404, "Not found");
  }
}

// ── Pages ──────────────────────────────────────────────────────────────────────────────────────────────────
//
// Each page is a full page load (with its own ads): public/layout.html around public/pages/<name>.html.
// The app runs on all of them, so a device stays connected and keeps sharing whichever page it's on.

/** Address → [file in public/pages, menu label]. In menu order. */
const PAGES = {
  "/": ["share", "Share"],
  "/devices": ["devices", "Devices"],
  "/how-it-works": ["how-it-works", "How it works"],
  "/privacy": ["privacy", "Privacy"],
  "/help": ["help", "Help"],
};

const inlineAd = (n) => `<div class="ad ad-inline" data-ad="ad${n}" hidden><span class="ad-label">Advertisement</span><div class="ad-body"></div></div>`;

async function renderPage(pathname) {
  const [file] = PAGES[pathname];
  const [layout, body] = await Promise.all([
    fsp.readFile(path.join(PUBLIC, "layout.html"), "utf8"),
    fsp.readFile(path.join(PUBLIC, "pages", `${file}.html`), "utf8"),
  ]);
  // The page's first line: <!-- title: … | description: … -->
  const meta = /^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\s*/s.exec(body);
  const content = (meta ? body.slice(meta[0].length) : body).replace("{{ad2}}", inlineAd(2)).replace("{{ad3}}", inlineAd(3));
  const nav = Object.entries(PAGES)
    .map(([href, [, label]]) => `<a href="${href}" data-nav${href === pathname ? ' aria-current="page"' : ""}>${label}${href === "/devices" ? '<span class="nav-badge" data-devices hidden></span>' : ""}</a>`)
    .join("");
  const fill = { title: meta?.[1] ?? "Wi-Fi Drop", description: meta?.[2] ?? "", page: file, nav, content };
  return layout
    .replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m)
    // The desktop icon of this page shows as selected.
    .replace(`<a class="desk-icon" href="${pathname}"`, `<a class="desk-icon" href="${pathname}" aria-current="page"`);
}

/** Small JSON bodies only: these are messages, never files. */
async function readJson(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("too big");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

function deviceKind(req) {
  if (isThisPc(req)) return "pc";
  const ua = req.headers["user-agent"] ?? "";
  if (/iPad|Tablet|MatePad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|Android|Mobile/i.test(ua)) return "phone";
  return "pc";
}

function deviceName(req, kind) {
  const ua = req.headers["user-agent"] ?? "";
  if (isThisPc(req)) return os.hostname();
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return kind === "tablet" ? "Android tablet" : "Android phone";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Mac/i.test(ua)) return "Mac";
  return "Device";
}

const server = http.createServer(async (req, res) => {
  if (!fromHomeNetwork(req)) {
    console.log(`  ! Refused ${req.socket.remoteAddress}: not on the home network`);
    return send(res, 403, "Wi-Fi Drop only works on its own home network: it can't be opened from outside it.", "text/plain; charset=utf-8", { connection: "close" });
  }
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  if (p.startsWith("/static/")) return serveStatic(res, p.slice("/static/".length));
  if (p === "/favicon.ico" || p === "/favicon.svg") return serveStatic(res, "favicon.svg");
  // AdSense checks this file to confirm the site is yours.
  if (p === "/ads.txt") {
    const pub = /^ca-(pub-\d{10,20})$/.exec(adsConfig()?.client ?? "")?.[1];
    return pub ? send(res, 200, `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`) : send(res, 404, "Not found");
  }

  // Everyone on the home network is welcome (fromHomeNetwork, above, already turned away everyone else): no key,
  // no invitation. It's a party.

  // Another computer is hosting Wi-Fi Drop on this network: everyone joins it there.
  if (hub && req.method === "GET" && (p === "/" || PAGES[p])) return send(res, 302, "", "text/plain", { location: hubUrl(isLocal(req)) });

  // Sent here by Wi-Fi Drop on another PC: the page learns that PC's name, and its way back if this one closes.
  // (Old QR links also carried a key in the address; it isn't needed any more, so it's just dropped.)
  if ((url.searchParams.has("home") || url.searchParams.has("k")) && req.method === "GET" && p === "/") {
    const pass = new URLSearchParams();
    for (const k of ["home", "name"]) if (url.searchParams.get(k)) pass.set(k, url.searchParams.get(k).slice(0, 64));
    return send(res, 302, "", "text/plain", { location: "/" + (pass.size ? `#${pass}` : "") });
  }

  try {
    if (PAGES[p] && req.method === "GET") return send(res, 200, await renderPage(p), "text/html; charset=utf-8");

    if (p === "/api/info" && req.method === "GET") {
      // Every computer gets the QR, to bring in more phones: this PC lists its networks, the others the address they used.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      const links = isLocal(req)
        ? lanAddresses().map((a) => ({ name: a.name, address: a.address, url: phoneLink(a.address) }))
        : /^[\d.]+$/.test(host) ? [{ name: "this network", address: host, url: phoneLink(host) }] : [];
      return json(res, 200, { local: isLocal(req), kind: deviceKind(req), ads: adsConfig(), links });
    }

    // A device picks its own name: from any of its windows, for all of them.
    if (p === "/api/name" && req.method === "POST") {
      const body = await readJson(req);
      const me = sender(body);
      if (!me) return json(res, 403, { error: "Unknown device: reload the page" });
      const name = cleanName(body.name);
      if (!name) return json(res, 400, { error: "Type a name" });
      for (const other of peers.values()) if (other.did === me.did) Object.assign(other, { name, named: true });
      peersChanged();
      return json(res, 200, { ok: true, name });
    }

    if (p === "/api/qr" && req.method === "GET") {
      const text = url.searchParams.get("text") ?? "";
      if (!text || text.length > 1000) return send(res, 400, "No text");
      return send(res, 200, await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), "image/svg+xml");
    }

    // A device joins: it gets an id (and a secret to prove it), and hears who else is here.
    if (p === "/api/events" && req.method === "GET") {
      const kind = deviceKind(req);
      req.socket.setKeepAlive(true, 5000);
      req.socket.setNoDelay(true);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 1500\n\n");
      const did = deviceKey(req); // the device, whichever tab, browser or private window this is
      // The tab, across its pages: a tab moving to another page of Wi-Fi Drop picks up where it was, same id and
      // same files, so for the other devices nothing changes.
      const session = /^[\w-]{16,64}$/.test(url.searchParams.get("s") ?? "") ? url.searchParams.get("s") : null;
      let id = session ? [...peers.keys()].find((k) => peers.get(k).session === session && peers.get(k).did === did) : undefined;
      let peer = id ? peers.get(id) : null;
      if (peer) {
        clearTimeout(peer.linger);
        if (peer.res && peer.res !== res) peer.res.end(); // its previous page, if still open
        peer.res = res;
      } else {
        id = crypto.randomBytes(6).toString("base64url");
        // Another window of a device that's already here (a second tab, a private window) takes the device's name.
        const sibling = [...peers.values()].find((o) => o.did === did && o.named);
        peer = {
          secret: crypto.randomBytes(12).toString("base64url"), did, session, kind, offers: [], res,
          name: sibling?.name ?? deviceName(req, kind), named: !!sibling,
          local: isLocal(req),
          // Its address on the home network, and the address it used to reach this PC (= the PC's, for it).
          ip: (req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
          host: (req.headers.host ?? "").replace(/:\d+$/, ""),
        };
        peers.set(id, peer);
        const windows = [...peers.values()].filter((o) => o.did === did).length;
        console.log(windows > 1 ? `  + ${peer.name}: another window (${windows} open, one device)` : `  + ${peer.name} connected`);
      }
      event(res, "hello", { id, secret: peer.secret, did });
      peersChanged();
      req.on("close", () => {
        if (peers.get(id) !== peer || peer.res !== res) return; // closed already, or moved on to its next page
        peer.res = null;
        // Gone for good, unless the tab is just loading another page: hold its place a few seconds.
        peer.linger = setTimeout(() => {
          if (peers.get(id) !== peer || peer.res) return;
          peers.delete(id);
          peersChanged();
          console.log(`  - ${peer.name} left`);
        }, peer.session ? 10_000 : 0);
      });
      return;
    }

    // A tab closing: drop it and its files from every device's list right away, not when its connection times out.
    if (p === "/api/leave" && req.method === "POST") {
      const body = await readJson(req);
      const gone = sender(body);
      if (gone) {
        clearTimeout(gone.linger);
        peers.delete(body.id);
        peersChanged();
        gone.res?.end();
        console.log(`  - ${gone.name} closed the page`);
      }
      return json(res, 200, { ok: true });
    }

    // Someone with access to a private file gives other devices access too (if the owner allows it). The list is
    // updated here at once, and the owner's device is told, since it's the one that checks before sending.
    if (p === "/api/grant" && req.method === "POST") {
      const body = await readJson(req);
      const me = sender(body);
      if (!me) return json(res, 403, { error: "Unknown device: reload the page" });
      const owner = peers.get(body.owner);
      const offer = owner?.offers.find((o) => o.fid === body.fid);
      if (!offer) return json(res, 404, { error: "That file isn't shared any more" });
      if (!offer.to) return json(res, 400, { error: "Everyone can already download it" });
      if (!offer.to.includes(me.did) || !offer.reshare) return json(res, 403, { error: "You can't give access to this file" });
      const add = (Array.isArray(body.to) ? body.to : []).filter((d) => typeof d === "string" && /^[\w-]{16}$/.test(d) && d !== owner.did);
      if (!add.length) return json(res, 400, { error: "Pick a device" });
      offer.to = [...new Set([...offer.to, ...add])].slice(0, 50);
      event(owner.res, "access", { fid: offer.fid, to: offer.to, by: me.name });
      peersChanged();
      return json(res, 200, { ok: true });
    }

    // What a device is offering: names and sizes. The files stay on it.
    if (p === "/api/offers" && req.method === "POST") {
      const body = await readJson(req);
      const me = sender(body);
      if (!me) return json(res, 403, { error: "Unknown device: reload the page" });
      me.offers = (Array.isArray(body.offers) ? body.offers : []).slice(0, 500).map(cleanOffer);
      peersChanged();
      return json(res, 200, { ok: true });
    }

    // Connection set-up between two devices (WebRTC offer, answer, network candidates), passed along as is.
    if (p === "/api/signal" && req.method === "POST") {
      const body = await readJson(req);
      const me = sender(body);
      if (!me) return json(res, 403, { error: "Unknown device: reload the page" });
      const to = peers.get(body.to);
      if (!to) return json(res, 404, { error: "That device has left" });
      event(to.res, "signal", { from: body.id, data: withRealAddress(body.data, me, to) });
      return json(res, 200, { ok: true });
    }

    send(res, 404, "Not found");
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: "Bad request" });
  }
});

server.headersTimeout = 60_000;

function openPath(target) {
  const [cmd, args] = process.platform === "win32" ? ["explorer", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`\n  Port ${PORT} is busy: is Wi-Fi Drop already running? (Or start it on another: set PORT=4041)\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", async () => {
  const best = lanAddresses()[0];
  console.log("\n  Wi-Fi Drop is running");
  console.log(`  On this PC:   http://localhost:${PORT}`);
  if (best) {
    console.log(`  Phone link:   ${phoneLink(best.address)}`);
    console.log(await QRCode.toString(phoneLink(best.address), { type: "terminal", small: true }));
  } else {
    console.log("  No home network found: connect this PC to your Wi-Fi.");
  }
  console.log("  Files go straight between your devices: nothing is sent to or saved by this app.");
  console.log("  Keep this window open while you share. Ctrl+C stops it.\n");
  if (DISCOVERY) startDiscovery();
  // A moment to find Wi-Fi Drop on other computers first, so the page opens straight on the shared one.
  if (!process.env.NO_OPEN) setTimeout(() => openPath(`http://localhost:${PORT}`), DISCOVERY ? 1500 : 0);
});
