// Wi-Fi Drop in the browser. Files go straight from one device to the other over a WebRTC data channel;
// the app on the PC only passes the connection set-up messages along. It never sees a file.
//
// This runs on every page (Share, Devices, How it works…): whichever page is open, the device stays connected and
// keeps serving its shared files. Each page has only some of the parts below; a part missing from this page is a
// stand-in element that goes nowhere, so the code can treat every page alike.
import { mascot, setMood } from "./mascot.js";
import { connect } from "./net.js";

const $ = (id) => document.getElementById(id) ?? document.createElement("div");
const onPage = (id) => !!document.getElementById(id);

/** Put Drip, the mascot, wherever the page asks for one: <span data-drip="mood" data-size="3">. */
function drips(root = document) {
  for (const el of root.querySelectorAll("[data-drip]")) {
    if (!el.firstElementChild) el.innerHTML = mascot(el.dataset.drip, { size: Number(el.dataset.size) || 3 });
  }
}
drips();

/** How two devices connect directly. Files only ever travel over this direct connection, never through a server. */
const RTC = { iceServers: [] }; // filled from /config.json: public helpers that let two devices find a direct path
// 64 KB: what every browser handles. Bigger messages make older phone browsers (Huawei Browser, older Chromium)
// close the channel mid-transfer.
const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024; // pause sending while this much is still queued (Chrome closes the channel past 16 MB)
const CONNECT_TIMEOUT = 20000;
/** A dropped transfer reconnects and carries on from where it stopped, up to this many times in a row. */
const MAX_TRIES = 6;
const RETRY_DELAY = 2000;
/** How long the sending side waits for a dropped transfer to come back before calling it failed. */
const RESUME_WAIT = 3 * 60 * 1000;
/** Above this a phone may run out of memory holding the file before saving it. */
const PHONE_MEMORY_WARN = 1.5 * 1024 ** 3;

const me = { id: null, secret: null, did: null };
const mine = new Map(); // fid → File: what this device shares
let peers = []; // other devices and what they offer
const conns = new Map(); // transfer id → { pc, pending: [] }
const earlyIce = new Map(); // transfer id → candidates that came before the offer (messages can overtake each other)
let active = 0; // transfers running

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────

function size(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ext = (name) => (name.includes(".") ? name.split(".").pop().slice(0, 4) : "file");

/** A colour family for the file's badge. */
function fileKind(name, type = "") {
  const e = (name.split(".").pop() || "").toLowerCase();
  if (type.startsWith("image/") || /^(jpe?g|png|gif|webp|heic|heif|bmp|svg|avif|tiff?|raw|dng)$/.test(e)) return "image";
  if (type.startsWith("video/") || /^(mp4|mov|mkv|avi|webm|m4v|3gp|wmv)$/.test(e)) return "video";
  if (type.startsWith("audio/") || /^(mp3|m4a|wav|flac|aac|ogg|opus|wma)$/.test(e)) return "audio";
  if (/^(xlsx?|csv|ods|numbers)$/.test(e)) return "sheet";
  if (/^(pdf|docx?|txt|rtf|odt|pptx?|key|pages|md|epub)$/.test(e)) return "doc";
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(e)) return "zip";
  if (/^(exe|msi|apk|dmg|pkg|deb|appx|ipa)$/.test(e)) return "app";
  return "other";
}
/** A file as a little paper sheet with a folded corner and a coloured label showing its type. */
const thumb = (name, type) => `<span class="thumb k-${fileKind(name, type)}" aria-hidden="true">
  <svg viewBox="0 0 34 40"><path class="paper" d="M4 2h18l9 9v26a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path class="fold" d="M22 2v9h9"/><rect class="label" x="3" y="20" width="28" height="11"/><path class="lines" d="M8 9h9M8 14h14"/></svg>
  <b>${esc(ext(name))}</b></span>`;

/** Small previews of this device's own photos (they're local, so it costs nothing). */
const previews = new Map(); // fid → object URL
function preview(fid, f) {
  if (!f.type.startsWith("image/") || f.size > 30 * 1024 ** 2) return null;
  if (!previews.has(fid)) previews.set(fid, URL.createObjectURL(f));
  return previews.get(fid);
}
function dropPreview(fid) {
  const url = previews.get(fid);
  if (url) { URL.revokeObjectURL(url); previews.delete(fid); }
}

let toastTimer;
/** Drip says something, in a speech bubble (looking sad when it's bad news). */
function toast(text) {
  const t = $("toast");
  $("toastText").textContent = text;
  setMood(t.querySelector(".mascot"), /couldn't|can't|stopped|isn't|don't|failed|no room|try again/i.test(text) ? "sad" : "happy");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/** This tab in the network's room (see net.js); null until it has joined. */
let net = null;
const signal = (to, data) => net?.signal(to, data);
/** Tell the room this device's name (from any of its tabs; the others follow, see renderSelf). */
const announceName = (name) => (net ? net.setName(name) : Promise.reject(new Error("offline")));

const ICON = {
  pc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`,
  tablet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  people: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18.5 14a6.5 6.5 0 0 1 3 6"/></svg>`,
  userPlus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
};

/** A device's own colour, the same on every screen (from its lasting id). */
function hue(s = "") {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
/** "Sam's phone" → "SP", "DESKTOP-L1FUR1J" → "DL", "Office" → "OF". */
function initials(name = "") {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "?";
  const two = words.length > 1 ? words[0][0] + words.at(-1)[0] : words[0].slice(0, 2);
  return two.toUpperCase();
}
/** A device as a coloured circle with its initials (and, large, a small phone / computer mark). */
/** Each device gets one of the five window colours, the same on every screen. */
const PALETTE = ["blue", "green", "yellow", "pink", "purple"];
const deviceColor = (p) => `var(--${PALETTE[hue(p.did || p.id || p.name) % PALETTE.length]})`;
const avatar = (p, small = false) =>
  `<span class="avatar${small ? " sm" : ""}" style="--c:${deviceColor(p)}" aria-hidden="true">${esc(initials(p.name))}${
    small ? "" : `<span class="avatar-kind">${ICON[p.kind] ?? ICON.pc}</span>`
  }</span>`;

// ── This device's name ─────────────────────────────────────────────────────────────────────────────────────

const store = {
  get(k, where = localStorage) { try { return where.getItem(k) || ""; } catch { return ""; } },
  set(k, v, where = localStorage) { try { where.setItem(k, v); } catch {} },
};
const cleanName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
/** A random id that's safe in a URL. */
function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Keeping this tab's files across its pages ──────────────────────────────────────────────────────────────
//
// Every click loads a new page, and a page forgets everything when it goes. So the files this tab shares (and
// received files waiting for their Save tap) are kept in the browser's own storage, under this tab's id: the next
// page picks them up and goes on sharing them, under the same id, so for the other devices nothing changes.
// Closing the tab deletes them (and the next visit clears anything a crashed tab left behind).

/** This tab, across its pages: session storage lasts as long as the tab, and no longer. */
const SESSION = (() => {
  let s = store.get("session", sessionStorage);
  if (!/^[\w-]{16,64}$/.test(s)) { s = token(); store.set("session", s, sessionStorage); }
  return s;
})();

const db = new Promise((resolve) => {
  try {
    const req = indexedDB.open("wifi-drop", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("files", { keyPath: "fid" }); // { fid, session, kind: "share" | "received", file, added, from? }
      d.createObjectStore("access", { keyPath: "fid" }); // { fid, to, reshare }: changes often, so apart from the file
      d.createObjectStore("tabs", { keyPath: "session" }); // { session, seen }: which tabs are still open
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  } catch {
    resolve(null); // storage blocked (some private windows): files are shared only while the page is open
  }
});
/** One request on one store; resolves with its result once written. */
function idb(name, mode, fn) {
  return db.then((d) => {
    if (!d) throw new Error("no storage");
    return new Promise((resolve, reject) => {
      const tx = d.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("storage"));
    });
  });
}

/** Shared files that couldn't be kept (no room, or storage blocked): they're lost if the page changes. */
const notKept = new Set();
let saving = Promise.resolve();
const track = (p) => { saving = Promise.all([saving, p.catch(() => {})]); return p; };

function keepShared(fid) {
  const file = mine.get(fid);
  return track(
    idb("files", "readwrite", (st) => st.put({ fid, session: SESSION, kind: "share", file, added: Date.now() }))
      .then(() => keepAccess(fid))
      .catch(() => {
        notKept.add(fid);
        toast(`${file.name} is shared, but only while you stay on this page: the browser had no room to keep it`);
      }),
  );
}
const keepAccess = (fid) => track(idb("access", "readwrite", (st) => st.put({ fid, ...access.get(fid) })).catch(() => {}));
const forget = (fid) => {
  notKept.delete(fid);
  idb("files", "readwrite", (st) => st.delete(fid)).catch(() => {});
  idb("access", "readwrite", (st) => st.delete(fid)).catch(() => {});
};

// This tab is open: say so now and then, so the next visit knows which kept files belong to closed tabs.
const heartbeat = () => idb("tabs", "readwrite", (st) => st.put({ session: SESSION, seen: Date.now() })).catch(() => {});
setInterval(heartbeat, 5000);

/** Delete what closed tabs left behind; bring back this tab's files. */
async function restore() {
  try {
    await heartbeat();
    const now = Date.now();
    const tabs = (await idb("tabs", "readonly", (st) => st.getAll())) ?? [];
    const open = new Set(tabs.filter((t) => now - t.seen < 30_000).map((t) => t.session));
    open.add(SESSION);
    const files = (await idb("files", "readonly", (st) => st.getAll())) ?? [];
    const acc = new Map(((await idb("access", "readonly", (st) => st.getAll())) ?? []).map((a) => [a.fid, a]));
    for (const t of tabs) if (!open.has(t.session)) idb("tabs", "readwrite", (st) => st.delete(t.session)).catch(() => {});
    // This tab left Wi-Fi Drop (for another site) and came back: what it shared then is gone.
    const left = store.get("left", sessionStorage) === "1";
    if (left) { open.delete(SESSION); sessionStorage.removeItem("left"); }
    for (const r of files.sort((a, b) => a.added - b.added)) {
      if (!open.has(r.session)) { forget(r.fid); continue; }
      if (r.session !== SESSION) continue; // another open tab's
      if (r.kind === "share") {
        mine.set(r.fid, r.file);
        const a = acc.get(r.fid);
        access.set(r.fid, { to: a?.to ?? null, reshare: a?.reshare !== false });
      } else if (r.kind === "received") {
        const row = transferRow("in", r.file.name, r.file.size, r.from ?? "a device");
        row.ready(r.file, r.fid);
      }
    }
  } catch {}
  try { defaultAccess = JSON.parse(store.get("defaultAccess", sessionStorage)) ?? defaultAccess; } catch {}
}

/** The tab is closing: its files go. */
function forgetTab() {
  for (const fid of mine.keys()) forget(fid);
  for (const fid of receivedKept) forget(fid);
  idb("tabs", "readwrite", (st) => st.delete(SESSION)).catch(() => {});
}
/** Received files kept for their Save tap, across pages. */
const receivedKept = new Set();


let renaming = false;
function renderSelf(name) {
  if (renaming) return;
  const sub = $("sub");
  sub.innerHTML = `<span class="me-label">This device</span><button class="nick" id="nick" type="button" title="Rename this device" aria-label="This device is ${esc(name)}. Rename it">${avatar({ name, did: me.did }, true)}${esc(name)}${ICON.edit}</button>`;
  $("nick").onclick = () => rename(name);
}
function rename(current) {
  renaming = true;
  $("sub").innerHTML = `<input class="nick-input" id="nickInput" maxlength="32" enterkeyhint="done" aria-label="Name for this device" />`;
  const input = $("nickInput");
  input.value = current;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const name = cleanName(input.value);
    if (!save || !name || name === current) return renderSelf(current);
    store.set("nick", name);
    $("nameForm").hidden = true;
    renderSelf(name);
    tabs.postMessage({ name });
    announceName(name).then(() => toast(`Everyone now sees this device as “${name}”`), () => toast("Couldn't rename it: try again"));
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

// First visit: ask for a name, so the others can tell which device this is.
if (!store.get("nick") && !store.get("nickAsked")) $("nameForm").hidden = false;
$("nameForm").onsubmit = (e) => {
  e.preventDefault();
  const name = cleanName($("nameInput").value);
  if (!name) return $("nameInput").focus();
  store.set("nick", name);
  $("nameForm").hidden = true;
  renderSelf(name);
  tabs.postMessage({ name });
  announceName(name).then(() => toast(`Everyone now sees this device as “${name}”`), () => toast("Couldn't save the name: try again"));
};
$("nameSkip").onclick = () => { store.set("nickAsked", "1"); $("nameForm").hidden = true; };

// ── This device, the site's settings, the join code ────────────────────────────────────────────────────────

/** Phone, tablet or computer, from the browser's own description. */
function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|MatePad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "tablet";
  if (/iPhone|Android|Mobile/i.test(ua)) return "phone";
  return "pc";
}
/** A first name for this device, until someone picks one. */
function defaultName(kind) {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (kind === "tablet") return /Android/.test(ua) ? "Android tablet" : "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Mac/.test(ua)) return "Mac";
  if (/CrOS/.test(ua)) return "Chromebook";
  return "Computer";
}

let link = "";
let config = { ads: null, iceServers: [] };
async function loadInfo() {
  try { config = await (await fetch("/config.json", { cache: "no-store" })).json(); } catch {}
  if (config.iceServers?.length) RTC.iceServers = config.iceServers;
  // Computers get the computer layout (drag and drop, side-by-side windows), phones a simpler one.
  document.body.classList.toggle("is-pc", deviceKind() === "pc");
  setupAds(config.ads);
  // The join code: the site's own address. Anyone on the same Wi-Fi who opens it lands in this same room.
  // (When testing on a PC, the local server says which secure address the other devices should open instead.)
  link = config.joinUrl || `${location.origin}/`;
  $("qr").innerHTML = `<img alt="QR code to open Wi-Fi Drop on another device" src="/api/qr?text=${encodeURIComponent(link)}" />`;
  $("url").textContent = link.replace(/^https?:\/\//, "");
}
// ── Ads (Google AdSense), set up in ads.json next to server.mjs ────────────────────────────────────────────

/**
 * Fills the ad spaces on the page. Ads only: they never see a file. Each space shows only when ads.json gives it
 * a slot id (or with "preview": true, as a labelled placeholder, to see where the ads go).
 */
function setupAds(ads) {
  if (!ads) return;
  const client = /^ca-pub-\d{10,20}$/.test(ads.client ?? "") ? ads.client : "";
  // No ads to show (none set up yet, no placeholders): the side columns go, and the content takes the whole width.
  const showing = ads.preview || (client && Object.values(ads.slots ?? {}).some((s) => /^\d{6,20}$/.test(String(s).trim())));
  document.body.classList.toggle("has-ads", !!showing);
  let any = false;
  for (const box of document.querySelectorAll("[data-ad]")) {
    const slot = String(ads.slots?.[box.dataset.ad] ?? "").trim();
    if (client && /^\d{6,20}$/.test(slot)) {
      box.hidden = false;
      if (!box.offsetParent) { box.hidden = true; continue; } // not shown on this device (the PC-only side space)
      const ins = document.createElement("ins");
      ins.className = "adsbygoogle";
      ins.style.display = "block";
      ins.dataset.adClient = client;
      ins.dataset.adSlot = slot;
      ins.dataset.adFormat = box.dataset.format || "auto";
      ins.dataset.fullWidthResponsive = box.dataset.format ? "false" : "true";
      box.querySelector(".ad-body").replaceChildren(ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      any = true;
    } else if (ads.preview) {
      box.hidden = false;
      if (!box.offsetParent) { box.hidden = true; continue; }
      box.classList.add("preview");
      const where = box.closest(".rail-left") ? "left side" : box.closest(".rail-right") ? "right side" : "between windows";
      box.querySelector(".ad-body").innerHTML = `<span>Ad space ${esc(box.dataset.ad.replace("ad", ""))} of 4</span><small>${where} · ${box.offsetWidth}px wide</small>`;
    }
  }
  if (any) {
    const s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`;
    document.head.append(s);
  }
}

$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { toast("Couldn't copy: select the link instead"); }
};

// ── Sharing from this device ───────────────────────────────────────────────────────────────────────────────

/**
 * Who has access to each shared file, like a shared drive:
 *   to: null (everyone on the network) or a list of devices (their lasting ids);
 *   reshare: whether those devices may give access to others too.
 * A private file is listed only to the devices on its list, and this device refuses to send it to any other
 * (see serve()). Devices with access can add people (see /api/grant); the PC tells this device, which keeps the list.
 */
const access = new Map(); // fid → { to: string[] | null, reshare: boolean }
/** Who new files are for: what "Share with" is set to. */
let defaultAccess = { to: null, reshare: true };
/** Names of the devices seen on the network, by lasting id: a file can stay shared with one that's away. */
const knownDevices = new Map(); // did → name

const deviceName = (did) => knownDevices.get(did) ?? "a device that left";
/** "Everyone", "Office PC", "Office PC and Sam's phone", "Office PC and 2 others". */
function audience(to) {
  if (!to) return "Everyone on this network";
  if (!to.length) return "Nobody yet";
  const names = to.map(deviceName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

function share(list, acc = defaultAccess) {
  const files = [...list].filter(Boolean);
  if (!files.length) return;
  for (const f of files) {
    const fid = rid();
    mine.set(fid, f);
    access.set(fid, { to: acc.to ? [...acc.to] : null, reshare: acc.reshare });
    keepShared(fid); // so it's still shared on the next page
  }
  publish();
  renderMine();
  const what = files.length === 1 ? files[0].name : `${files.length} files`;
  toast(acc.to ? `Shared ${what} with ${audience(acc.to)} only` : `Shared ${what} with everyone`);
}

function unshare(fid) {
  mine.delete(fid);
  access.delete(fid);
  dropPreview(fid);
  forget(fid);
}

/** Tell the others what's on offer: names and sizes only, and who has access to each. */
function publish() {
  if (!net) return;
  const offers = [...mine.entries()].map(([fid, f]) => {
    const a = access.get(fid) ?? { to: null, reshare: true };
    return { fid, name: f.name, size: f.size, type: f.type, to: a.to, reshare: a.reshare };
  });
  net.setOffers(offers).catch(() => {});
}

/** Every other device, once each (two tabs of one browser are one device), plus any listed that are away. */
function deviceChoices(extra = []) {
  const out = new Map();
  for (const p of peers) if (p.did && p.did !== me.did) out.set(p.did, { name: p.name, online: true });
  for (const did of extra) if (did !== me.did && !out.has(did)) out.set(did, { name: deviceName(did), online: false });
  return out;
}

// ── The access dialog: "who can download this?" ────────────────────────────────────────────────────────────

/**
 * Owner mode: everyone, or chosen devices, and whether they may pass access on.
 * Grant mode (someone else's file): pick devices to give access to.
 * Resolves with { to, reshare } or null when cancelled.
 */
function askAccess({ title, sub = "", mode = "owner", current = { to: null, reshare: true }, exclude = [] }) {
  const dlg = $("access");
  $("accessTitle").textContent = title;
  $("accessSub").textContent = sub;
  const owner = mode === "owner";
  $("accessModes").hidden = !owner;
  $("accessReshareRow").hidden = !owner;
  $("accessSave").textContent = owner ? "Save" : "Give access";

  const list = $("accessList");
  const choices = deviceChoices(current.to ?? []);
  for (const did of exclude) choices.delete(did);
  list.innerHTML = choices.size
    ? [...choices].map(([did, d]) => `<label class="pick-device">
        <input type="checkbox" value="${esc(did)}"${current.to?.includes(did) ? " checked" : ""} />
        ${avatar({ name: d.name, did }, true)}<span class="pick-name">${esc(d.name)}</span>${d.online ? "" : `<span class="pick-away">not connected</span>`}
      </label>`).join("")
    : `<p class="muted pick-none">No other devices here yet. They appear as they open Wi-Fi Drop.</p>`;

  const everyone = $("accessEveryone");
  const chosen = $("accessChosen");
  (current.to ? chosen : everyone).checked = true;
  $("accessReshare").checked = current.reshare !== false;
  const sync = () => {
    const pickOn = !owner || chosen.checked;
    list.classList.toggle("off", !pickOn);
    $("accessReshareRow").classList.toggle("off", !pickOn);
    for (const box of list.querySelectorAll("input")) box.disabled = !pickOn;
  };
  everyone.onchange = chosen.onchange = sync;
  // Ticking a device means "only these": switch to that.
  list.onchange = () => { if (owner) { chosen.checked = true; sync(); } };
  sync();

  return new Promise((resolve) => {
    const done = (value) => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(value); };
    $("accessCancel").onclick = () => done(null);
    dlg.onclose = () => done(null);
    $("accessForm").onsubmit = (e) => {
      e.preventDefault();
      const ticked = [...list.querySelectorAll("input:checked")].map((b) => b.value);
      if (!owner) return ticked.length ? done({ to: ticked }) : toast("Tick at least one device");
      if (everyone.checked) return done({ to: null, reshare: true });
      // Devices on the list that are away (and not shown as choices) stay on it.
      const kept = (current.to ?? []).filter((d) => !choices.has(d));
      done({ to: [...new Set([...kept, ...ticked])], reshare: $("accessReshare").checked });
    };
    dlg.showModal();
  });
}

function renderSendTo() {
  const label = $("sendTo").querySelector("span");
  if (label) label.textContent = defaultAccess.to ? `Only ${audience(defaultAccess.to)}` : "Everyone on this network";
  $("sendToRow").classList.toggle("private", !!defaultAccess.to);
}
$("sendTo").onclick = async () => {
  const a = await askAccess({ title: "Share new files with", sub: "Files you add from now on go to these people.", current: defaultAccess });
  if (!a) return;
  defaultAccess = a;
  store.set("defaultAccess", JSON.stringify(a), sessionStorage);
  renderSendTo();
};

async function editAccess(fid) {
  const f = mine.get(fid);
  const a = await askAccess({ title: `Who can download ${f.name}?`, current: access.get(fid) });
  if (!a || !mine.has(fid)) return;
  access.set(fid, a);
  keepAccess(fid);
  publish();
  renderMine();
  toast(a.to ? `${f.name}: shared with ${audience(a.to)}` : `${f.name}: everyone can download it`);
}

function renderMine() {
  const ul = $("mine");
  ul.replaceChildren();
  $("mineHead").hidden = mine.size === 0;
  $("keepOpen").hidden = mine.size === 0;
  $("mineCount").textContent = mine.size || "";
  renderSummary();
  for (const [fid, f] of mine) {
    const a = access.get(fid) ?? { to: null };
    const li = document.createElement("li");
    li.className = `file${a.to ? " is-private" : ""}`;
    const img = preview(fid, f);
    // A photo shows itself; one the browser can't show (HEIC on Windows, say) falls back to its badge.
    li.innerHTML = `${img ? `<span class="thumb k-image"><span>${esc(ext(f.name))}</span><img alt="" src="${img}" onerror="this.remove()" /></span>` : thumb(f.name, f.type)}
      <div class="info"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="meta">${size(f.size)}
          <button class="to-pick" type="button" title="Change who can download it">${a.to ? ICON.lock : ICON.people}<span>${esc(a.to ? audience(a.to) : "Everyone")}</span>${ICON.chevron}</button>
        </span>
      </div>
      <div class="actions"><button class="icon-btn danger" type="button" data-stop title="Stop sharing" aria-label="Stop sharing ${esc(f.name)}">${ICON.x}</button></div>`;
    li.querySelector(".to-pick").onclick = () => editAccess(fid);
    li.querySelector("[data-stop]").onclick = () => { unshare(fid); publish(); renderMine(); };
    ul.append(li);
  }
}
$("clearMine").onclick = () => { for (const fid of [...mine.keys()]) unshare(fid); publish(); renderMine(); };

/**
 * Someone asks to give other devices access to one of this tab's private files. This tab decides: only a device
 * that has access itself, on a file whose owner allowed passing it on. (Who's asking comes from the room, which
 * can't be faked.)
 */
function onAccessGranted({ fid, add, fromDid, by }) {
  const a = access.get(fid);
  if (!a?.to || !a.reshare || !a.to.includes(fromDid)) return;
  const added = add.filter((d) => typeof d === "string" && /^[\w-]{16}$/.test(d) && d !== me.did && !a.to.includes(d));
  if (!added.length) return;
  a.to = [...a.to, ...added].slice(0, 50);
  keepAccess(fid);
  publish();
  renderMine();
  if (added.length) toast(`${by} gave ${audience(added)} access to ${mine.get(fid)?.name ?? "a file"}`);
}

$("pick").onchange = (e) => { share(e.target.files); e.target.value = ""; };
// "Send files to …" on a device's panel: pick files for that device only.
let pickFor = null;
$("pickFor").onchange = (e) => { if (pickFor) share(e.target.files, { to: [pickFor], reshare: true }); e.target.value = ""; pickFor = null; };
function sendFilesTo(did) {
  pickFor = did;
  $("pickFor").click();
}

/** Give other devices access to a file someone else shared with this one. */
async function giveAccess(peer, file) {
  const a = await askAccess({
    title: `Give access to ${file.name}`,
    sub: `They'll be able to download it from ${peer.name}.`,
    mode: "grant",
    exclude: [peer.did],
  });
  if (!a) return;
  try {
    await net.grant(holderOf(peer, file), file.fid, a.to);
    toast(`${audience(a.to)} can now download ${file.name}`);
  } catch (e) {
    toast(e.message || "Couldn't give access: try again");
  }
}

let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
const hot = (on) => {
  $("overlay").hidden = !on;
  $("drop").classList.toggle("hot", on);
  setMood($("drop").querySelector(".mascot"), on ? "happy" : "idle"); // Drip gets excited when files come near
};
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; hot(true); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; hot(false); } });
window.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; hot(false); share(e.dataTransfer.files); });
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].map((f) =>
    f.name === "image.png" ? new File([f], `Pasted ${new Date().toLocaleString().replace(/[/:]/g, "-")}.png`, { type: f.type }) : f,
  );
  if (files.length) { e.preventDefault(); share(files); }
});

// ── Moving between pages, and closing the tab ──────────────────────────────────────────────────────────────

/** Downloads coming in right now: these restart if this page goes, so ask first. */
let incoming = 0;
/** This page is going to another page of Wi-Fi Drop (not closing): the files stay shared. */
let toNextPage = false;

/** Anything a page change would lose, as a question to ask; "" when it's safe. */
function leaveQuestion() {
  if (incoming) return `${incoming === 1 ? "A download is" : `${incoming} downloads are`} still coming in. Leaving this page restarts ${incoming === 1 ? "it" : "them"}. Leave anyway?`;
  const lost = [...mine.keys()].filter((fid) => notKept.has(fid));
  if (lost.length) return `${lost.length === 1 ? mine.get(lost[0]).name : `${lost.length} files`} can only be shared from this page (the browser had no room to keep ${lost.length === 1 ? "it" : "them"}). Leave and stop sharing ${lost.length === 1 ? "it" : "them"}?`;
  return "";
}

// A link to another page of Wi-Fi Drop: keep everything, finish storing new files, then go.
document.addEventListener("click", async (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.protocol === "blob:") return; // elsewhere (an ad, another computer)
  if (url.pathname === location.pathname && url.search === location.search) return;
  e.preventDefault();
  const question = leaveQuestion();
  if (question && !confirm(question)) return;
  toNextPage = true;
  await Promise.race([saving, new Promise((r) => setTimeout(r, 8000))]);
  location.assign(url.href);
});
// Reloading, Back and Forward stay within Wi-Fi Drop too (where the browser can tell: Chrome, Edge, newer others).
window.navigation?.addEventListener("navigate", (e) => {
  try { if (new URL(e.destination.url).origin === location.origin) toNextPage = true; } catch {}
});

// Closing the tab mid-download, or with files only this page can share: say so.
window.addEventListener("beforeunload", (e) => {
  if (incoming || (!toNextPage && [...mine.keys()].some((fid) => notKept.has(fid)))) e.preventDefault();
});

// The tab is closing (not moving to another page): its files are gone, so tell the others at once and they vanish
// from every device's list right away, and delete what this tab kept.
window.addEventListener("pagehide", () => {
  if (toNextPage || !net) return;
  net.leave();
  // Deleting may not finish as the page goes: note it (instantly), so coming back in this tab doesn't revive them.
  store.set("left", "1", sessionStorage);
  forgetTab();
});
// Coming back with the browser's Back button from a page kept in memory: load it fresh.
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

// ── Other devices ──────────────────────────────────────────────────────────────────────────────────────────

/*
 * The list from the PC has one entry per DEVICE, not per tab: every tab, browser and private window on one phone
 * or computer counts as that one device (the PC tells them apart by their address on the Wi-Fi). Each shared file
 * says which tab holds it (owner), since that's the window that sends it.
 */

/** Every device but this one (this one's other tabs and windows included in "this one"). */
const otherDevices = () => peers.filter((p) => p.did !== me.did);
/** The device a tab belongs to. */
const deviceOfTab = (tabId) => peers.find((p) => p.id === tabId || p.tabs?.includes(tabId));
/** The tab holding a shared file, to ask for it. */
const holderOf = (device, file) => file.owner ?? device.offers.find((o) => o.fid === file.fid)?.owner ?? device.id;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const totalSize = (files) => size(files.reduce((a, f) => a + f.size, 0));

/** The device whose files are open below the grid (its lasting id), or null. */
let openPeer = null;

/** The other devices as a grid of tiles: click one to see what it shares. */
function renderPeers() {
  const others = otherDevices();
  $("noPeers").hidden = others.length > 0;
  $("peersHint").hidden = others.length === 0;
  if (openPeer && !others.some((p) => p.did === openPeer)) openPeer = null; // it left
  const focused = document.activeElement?.dataset?.peer; // keep the keyboard where it was across updates

  const grid = $("peers");
  grid.replaceChildren();
  for (const p of others) {
    const n = p.offers.length;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `device${n ? " has-files" : ""}${p.did === openPeer ? " open" : ""}`;
    tile.dataset.peer = p.did;
    tile.setAttribute("aria-expanded", String(p.did === openPeer));
    tile.setAttribute("aria-controls", "peerFiles");
    tile.style.setProperty("--c", deviceColor(p));
    tile.innerHTML = `<span class="device-top">
        ${avatar(p)}
        ${n ? `<span class="badge" aria-hidden="true">${n}</span>` : ""}
      </span>
      <span class="device-name" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="device-meta">${n ? `${plural(n, "file")} · ${totalSize(p.offers)}` : "Nothing shared yet"}</span>
      ${p.offers.some((o) => o.private) ? `<span class="device-tag for-you">${ICON.lock}Shared with you</span>` : ""}`;
    tile.onclick = () => {
      openPeer = openPeer === p.did ? null : p.did;
      renderPeers();
      if (openPeer) $("peerFiles").scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    grid.append(tile);
  }
  if (focused) grid.querySelector(`[data-peer="${CSS.escape(focused)}"]`)?.focus();
  renderPeerFiles(others.find((p) => p.did === openPeer));
}

/** The open device's files, kept up to date as it adds or removes some. */
function renderPeerFiles(p) {
  const panel = $("peerFiles");
  panel.hidden = !p;
  panel.replaceChildren();
  if (!p) return;
  const files = p.offers;
  // A window of its own, in that device's colour, with a working close button.
  const titleBar = document.createElement("div");
  titleBar.className = "win-bar";
  titleBar.innerHTML = `<span class="win-title">Files from ${esc(p.name)}</span>
    <button class="win-close" type="button" data-close aria-label="Close">${ICON.x}</button>`;
  panel.append(titleBar);
  const head = document.createElement("div");
  head.className = "peer-files-head";
  head.innerHTML = `${avatar(p)}
    <div class="info"><span class="name">${esc(p.name)}</span><span class="meta">${files.length ? `Sharing ${plural(files.length, "file")} · ${totalSize(files)}` : "Not sharing anything yet"}</span></div>
    ${files.length > 1 ? `<button class="btn" type="button" data-all>${ICON.download}<span>Download all</span></button>` : ""}`;
  head.querySelector("[data-all]")?.addEventListener("click", () => receiveAll(p, files));

  // Send this device something, for it only.
  const send = document.createElement("button");
  send.type = "button";
  send.className = "send-to";
  send.innerHTML = `${ICON.send}<span>Send files to <b>${esc(p.name)}</b> only</span>`;
  send.onclick = () => sendFilesTo(p.did);
  if (!p.did || p.did === me.did) send.hidden = true; // this same device
  titleBar.querySelector("[data-close]").onclick = () => { openPeer = null; renderPeers(); };
  panel.append(head);

  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "peer-files-empty";
    empty.textContent = `When ${p.name} shares files, they appear here straight away.`;
    panel.append(empty, send);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "files inner";
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "file";
    // Shared privately: say with whom, and (if the owner allows) let this device give others access too.
    const shared = f.private ? (f.access > 1 ? `Shared with you and ${plural(f.access - 1, "other")}` : "Shared with you only") : "";
    const canGive = f.private && f.reshare;
    li.innerHTML = `${thumb(f.name, f.type)}
      <div class="info"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="meta">${size(f.size)}${shared ? ` · <span class="for-you-inline">${ICON.lock}${shared}</span>` : ""}</span></div>
      <div class="actions">
        ${canGive ? `<button class="icon-btn" type="button" data-give title="Give others access" aria-label="Give others access to ${esc(f.name)}">${ICON.userPlus}</button>` : ""}
        <button class="btn primary download" type="button" aria-label="Download ${esc(f.name)}">${ICON.download}<span>Download</span></button>
      </div>`;
    // The whole row grabs the file, not just its button.
    li.classList.add("grab");
    li.title = `Download ${f.name}`;
    li.onclick = () => receiveOne(p, f);
    li.querySelector("[data-give]")?.addEventListener("click", (e) => { e.stopPropagation(); giveAccess(p, f); });
    ul.append(li);
  }
  panel.append(ul, send);
}

// ── Transfers: progress rows ───────────────────────────────────────────────────────────────────────────────

/** A little yellow folder: where the file comes from, and where it goes (the "Copy" window). */
const FOLDER = `<svg viewBox="0 0 40 34" aria-hidden="true"><path d="M8 4h15l5 5v12H8Z" fill="#fff" stroke="#1d1a17" stroke-width="2.4" stroke-linejoin="round"/><path d="M2 9h10l3 3h22v19H2Z" fill="#f6b928" stroke="#1d1a17" stroke-width="2.4" stroke-linejoin="round"/><path d="M2 16h35" fill="none" stroke="#1d1a17" stroke-width="2.4"/></svg>`;

function transferRow(direction, name, total, peerName) {
  const li = document.createElement("li");
  li.className = "up";
  // Drip walks along the bar, carrying the file: where it stands is how far the file has got.
  li.innerHTML = `<div class="up-top"><span class="up-name"></span><span class="up-pct">Connecting…</span></div>
    <div class="copy"><span class="copy-end">${FOLDER}</span><div class="track"><span class="walker">${mascot("idle", { size: 2 })}</span><div class="bar"><span></span></div></div><span class="copy-end">${FOLDER}</span></div>`;
  li.querySelector(".up-name").textContent = `${direction === "in" ? "↓" : "↑"} ${name} · ${direction === "in" ? "from" : "to"} ${peerName}`;
  $("transfers").append(li);
  const pct = li.querySelector(".up-pct");
  const bar = li.querySelector(".bar span");
  const walker = li.querySelector(".walker");
  const drip = li.querySelector(".mascot");
  const started = performance.now();
  active++;
  let ended = false;
  const end = () => { if (!ended) { ended = true; active--; } };
  const at = (p) => { bar.style.width = `${p * 100}%`; walker.style.left = `${p * 100}%`; };
  return {
    progress(done) {
      const secs = (performance.now() - started) / 1000;
      const speed = secs > 0.5 ? ` · ${size(done / secs)}/s` : "";
      const p = total ? done / total : 1;
      pct.textContent = `${Math.floor(p * 100)}% of ${size(total)}${speed}`;
      at(p);
      setMood(drip, "carry");
    },
    status(text) { pct.textContent = text; setMood(drip, /drop|resum|retry/i.test(text) ? "idle" : "walk"); },
    done(text) {
      end();
      at(1);
      setMood(drip, "happy");
      pct.textContent = text;
      li.classList.add("ok");
      setTimeout(() => li.remove(), 4000);
    },
    /**
     * Received into memory: the browser only saves it on a tap of yours, so offer the buttons. The file is kept
     * for the next pages too, until it's dismissed (keptFid: already kept, brought back by a new page).
     */
    ready(file, keptFid = null) {
      end();
      const url = URL.createObjectURL(file);
      const fid = keptFid ?? `r-${rid()}`;
      receivedKept.add(fid);
      if (!keptFid) {
        track(idb("files", "readwrite", (st) => st.put({ fid, session: SESSION, kind: "received", file, from: peerName, added: Date.now() })).catch(() => {}));
      }
      at(1);
      setMood(drip, "happy");
      li.classList.add("ok", "ready");
      pct.textContent = `Received ${size(total)}: tap Save`;
      const row = document.createElement("div");
      row.className = "up-actions";
      row.innerHTML = `<a class="btn primary" href="${url}" download="${esc(file.name)}">${ICON.download}<span>Save</span></a>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>
        <button class="icon-btn" type="button" aria-label="Dismiss">${ICON.x}</button>`;
      const [save] = row.children;
      save.addEventListener("click", () => {
        pct.textContent = "Saved: check your Downloads";
        save.classList.remove("primary");
        save.querySelector("span").textContent = "Save again";
      });
      row.querySelector("button").onclick = () => { li.remove(); URL.revokeObjectURL(url); receivedKept.delete(fid); forget(fid); };
      li.append(row);
    },
    fail(text) {
      end();
      setMood(drip, "sad");
      li.classList.add("failed");
      pct.textContent = text;
      setTimeout(() => li.remove(), 12000);
    },
  };
}

// ── Connections ────────────────────────────────────────────────────────────────────────────────────────────

/** A connection for one transfer; network candidates that arrive before it's ready wait their turn. */
function newConnection(tid, peerId) {
  const pc = new RTCPeerConnection(RTC);
  const c = { pc, pending: earlyIce.get(tid) ?? [], ready: false };
  earlyIce.delete(tid);
  conns.set(tid, c);
  pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { t: "ice", tid, c: e.candidate.toJSON() }); };
  const close = () => { try { pc.close(); } catch {} conns.delete(tid); };
  c.close = close;
  return c;
}

async function remoteReady(c, sdp) {
  await c.pc.setRemoteDescription(sdp);
  c.ready = true;
  for (const cand of c.pending.splice(0)) await c.pc.addIceCandidate(cand).catch(() => {});
}

async function onSignal({ from, data }) {
  const c = conns.get(data.tid);
  if (data.t === "offer") {
    // Someone wants one of this device's files.
    const s = newConnection(data.tid, from);
    s.pc.ondatachannel = (e) => serve(e.channel, from, s);
    await remoteReady(s, data.sdp);
    const answer = await s.pc.createAnswer();
    await s.pc.setLocalDescription(answer);
    signal(from, { t: "answer", tid: data.tid, sdp: s.pc.localDescription.toJSON() });
  } else if (data.t === "answer" && c) {
    await remoteReady(c, data.sdp);
  } else if (data.t === "ice") {
    if (!c) earlyIce.set(data.tid, [...(earlyIce.get(data.tid) ?? []), data.c]);
    else if (c.ready) await c.pc.addIceCandidate(data.c).catch(() => {});
    else c.pending.push(data.c);
  }
}

// ── Sending (this device has the file) ─────────────────────────────────────────────────────────────────────

/** Transfers this device is sending, by the receiver's transfer key: a resumed one keeps its row. */
const outgoing = new Map(); // xid → { row, timer }

function serve(dc, peerId, conn) {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;
  dc.onclose = () => setTimeout(conn.close, 1000);
  dc.onmessage = async (e) => {
    if (typeof e.data !== "string") return;
    const { fid, offset, xid } = JSON.parse(e.data);
    const file = mine.get(fid);
    if (!file) return dc.send(JSON.stringify({ error: "That file isn't shared any more" }));
    // Shared with chosen devices only: check the one asking is on the list (its lasting id comes from the PC,
    // which verified it).
    const allowed = access.get(fid)?.to;
    if (allowed && !allowed.includes(deviceOfTab(peerId)?.did)) {
      return dc.send(JSON.stringify({ error: "You don't have access to that file" }));
    }
    const start = Math.max(0, Math.min(Number(offset) || 0, file.size));
    let out = xid ? outgoing.get(xid) : null;
    if (out) clearTimeout(out.timer);
    else {
      const peerName = deviceOfTab(peerId)?.name ?? "a device";
      out = { row: transferRow("out", file.name, file.size, peerName) };
      if (xid) outgoing.set(xid, out);
    }
    const { row } = out;
    try {
      let sent = start;
      let lastPaint = 0;
      // Read a megabyte at a time, send it in pieces every browser accepts.
      for (let off = start; off < file.size; off += 16 * CHUNK) {
        const buf = await file.slice(off, off + 16 * CHUNK).arrayBuffer();
        for (let i = 0; i < buf.byteLength; i += CHUNK) {
          if (dc.readyState !== "open") throw new Error("closed");
          if (dc.bufferedAmount > HIGH_WATER) await drained(dc);
          dc.send(buf.slice(i, i + CHUNK));
          sent += Math.min(CHUNK, buf.byteLength - i);
          if (performance.now() - lastPaint > 150) { row.progress(sent); lastPaint = performance.now(); }
        }
      }
      dc.send(JSON.stringify({ done: true }));
      outgoing.delete(xid);
      row.done(`Sent ${size(file.size)}`);
    } catch {
      // The receiving side reconnects and asks for the rest: give it a while before calling it failed.
      row.status("Connection dropped: waiting for the other device to resume…");
      out.timer = setTimeout(() => {
        outgoing.delete(xid);
        row.fail("Stopped: the other device closed or lost the connection");
      }, RESUME_WAIT);
    }
  };
}

const drained = (dc) => new Promise((resolve, reject) => {
  const ok = () => { dc.removeEventListener("close", bad); resolve(); };
  const bad = () => { dc.removeEventListener("bufferedamountlow", ok); reject(new Error("closed")); };
  dc.addEventListener("bufferedamountlow", ok, { once: true });
  dc.addEventListener("close", bad, { once: true });
});

// ── Receiving (the other device has the file) ──────────────────────────────────────────────────────────────

const isPhone = () => !document.body.classList.contains("is-pc") && !window.showSaveFilePicker;

/**
 * Where an incoming file goes. On the PC (Chrome or Edge), straight to disk as it arrives, so any size works.
 * Elsewhere it's held in memory and saved at the end.
 */
async function openSink(file, dir) {
  if (dir) {
    const handle = await dir.getFileHandle(await freeName(dir, file.name), { create: true });
    return diskSink(await handle.createWritable());
  }
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: file.name });
    return diskSink(await handle.createWritable());
  }
  // Held in memory, then saved with a tap: a download the page starts by itself (after the transfer) is
  // blocked by many phone and tablet browsers (Huawei Browser among them).
  const parts = [];
  return {
    manual: true,
    write: (chunk) => parts.push(chunk),
    async close() {
      const received = new File(parts, file.name, { type: file.type || "application/octet-stream" });
      parts.length = 0;
      return received;
    },
    abort() { parts.length = 0; },
  };
}

function diskSink(writable) {
  const w = writable.getWriter();
  return { write: (chunk) => { w.write(chunk).catch(() => {}); }, close: () => w.close(), abort: () => w.abort().catch(() => {}) };
}

/** "photo.jpg", or "photo (2).jpg" when the folder already has one. */
async function freeName(dir, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try { await dir.getFileHandle(candidate); } catch { return candidate; }
  }
}

function memoryOk(files) {
  const big = files.filter((f) => f.size > PHONE_MEMORY_WARN);
  if (!isPhone() || !big.length) return true;
  return confirm(`${big.map((f) => `${f.name} (${size(f.size)})`).join(", ")} is very big for a phone: it's held in memory until it's saved, and may fail. Try anyway?`);
}

async function receiveOne(peer, file) {
  if (!memoryOk([file])) return;
  let sink;
  try { sink = await openSink(file); } catch { return; } // the save dialog was cancelled
  receive(peer, file, sink);
}

async function receiveAll(peer, files) {
  if (!memoryOk(files)) return;
  // On the PC: pick a folder once, and every file goes into it.
  if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
    for (const f of files) receive(peer, f, await openSink(f, dir));
    return;
  }
  for (const f of files) receive(peer, f, await openSink(f));
}

const NO_DIRECT = "Couldn't connect directly. Same Wi-Fi? Some routers keep devices apart (AP isolation).";

function receive(peer, file, sink) {
  const row = transferRow("in", file.name, file.size, peer.name);
  incoming++;
  const xid = rid(); // this transfer, across reconnects
  let got = 0;
  let lastPaint = 0;
  let finished = false;
  let everOpened = false;
  let tries = 0;
  let gone = 0; // attempts in a row where no device offered the file
  let c = null; // the current connection
  let timer = null;

  const finish = async (ok, text) => {
    if (finished) return;
    finished = true;
    incoming--;
    clearTimeout(timer);
    const conn = c;
    if (!ok) { sink.abort(); row.fail(text); }
    else if (sink.manual) row.ready(await sink.close());
    else { await sink.close(); row.done(text); }
    if (conn) setTimeout(conn.close, 500);
  };

  // A dropped connection (a Wi-Fi hiccup, the phone's screen going off, the page in the background):
  // connect again and carry on from the last byte received.
  const retry = (reason) => {
    if (finished) return;
    clearTimeout(timer);
    c?.close();
    c = null;
    if (++tries > MAX_TRIES) return finish(false, everOpened ? reason : NO_DIRECT);
    row.status(got ? `Connection dropped at ${Math.floor((got / file.size) * 100)}%: resuming…` : "Retrying…");
    setTimeout(attempt, RETRY_DELAY);
  };

  function attempt() {
    if (finished) return;
    // The other device may have rejoined under a new id: ask whoever offers this file now.
    const owner = peers.find((p) => p.offers.some((o) => o.fid === file.fid)) ?? (tries === 0 ? peer : null);
    if (!owner) {
      // Gone for longer than a reconnect takes: the page was closed, and its files with it.
      if (++gone >= 3) return finish(false, "Stopped: the other device closed the page, so the file is gone");
      return retry("Stopped: the other device closed the page or stopped sharing");
    }
    gone = 0;

    const tid = rid();
    const tab = holderOf(owner, file); // the window on that device that holds the file
    const conn = newConnection(tid, tab);
    c = conn;
    const live = () => c === conn && !finished;
    timer = setTimeout(() => { if (live()) retry(NO_DIRECT); }, CONNECT_TIMEOUT);
    conn.pc.onconnectionstatechange = () => {
      if (live() && conn.pc.connectionState === "failed") retry("Stopped: lost the connection to the other device");
    };

    const dc = conn.pc.createDataChannel("file", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      if (!live()) return;
      clearTimeout(timer);
      everOpened = true;
      row.status(got ? "Resuming…" : "Starting…");
      dc.send(JSON.stringify({ fid: file.fid, offset: got, xid }));
    };
    dc.onmessage = (e) => {
      if (!live()) return;
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        if (m.error) finish(false, m.error);
        else if (m.done) finish(got === file.size, got === file.size ? `Saved ${size(file.size)}` : "Incomplete: try again");
        return;
      }
      sink.write(e.data);
      got += e.data.byteLength;
      tries = 0; // it's moving again: a later drop gets a fresh set of retries
      if (performance.now() - lastPaint > 150) { row.progress(got); lastPaint = performance.now(); }
    };
    dc.onclose = () => { if (live()) retry("Stopped: the other device closed the page or stopped sharing"); };

    (async () => {
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      signal(tab, { t: "offer", tid, sdp: conn.pc.localDescription.toJSON() });
    })().catch(() => { if (live()) retry("Couldn't start the connection"); });
  }

  attempt();
}

// ── Joining ────────────────────────────────────────────────────────────────────────────────────────────────

/** Files that just appeared (to highlight them in "Shared with you"). */
let freshFiles = new Set();
/** New files from other devices: say so once (once per tab, not again on every page). */
const seenPrivate = new Set(store.get("seenPrivate", sessionStorage).split("\n").filter(Boolean));
function announcePrivate() {
  const fresh = new Map(); // sender name → the new files' names
  freshFiles = new Set();
  for (const p of otherDevices()) {
    for (const o of p.offers) {
      const key = `${p.did}/${o.fid}`;
      if (seenPrivate.has(key)) continue;
      seenPrivate.add(key);
      freshFiles.add(key);
      fresh.set(p.name, [...(fresh.get(p.name) ?? []), o.name]);
    }
  }
  if (!fresh.size) return;
  store.set("seenPrivate", [...seenPrivate].slice(-300).join("\n"), sessionStorage);
  const where = document.body.dataset.page === "share" ? "" : ": see Share";
  for (const [name, files] of fresh) toast(`${name} shared ${files.length === 1 ? files[0] : `${files.length} files`}${where}`);
}

/** "Shared with you" (Share page): every file the other devices share with this one, ready to download. */
function renderInbox() {
  const ul = $("inbox");
  const rows = otherDevices().flatMap((p) => p.offers.map((f) => ({ p, f })));
  $("inboxCount").textContent = rows.length || "";
  ul.replaceChildren();
  for (const { p, f } of rows) {
    const li = document.createElement("li");
    li.className = `file grab${freshFiles.has(`${p.did}/${f.fid}`) ? " fresh" : ""}`;
    li.title = `Download ${f.name}`;
    li.innerHTML = `${thumb(f.name, f.type)}
      <div class="info"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="meta">${size(f.size)} · from <span class="from">${esc(p.name)}</span>${f.private ? ` · <span class="for-you-inline">${ICON.lock}Just you</span>` : ""}</span></div>
      <div class="actions"><button class="btn primary download" type="button" aria-label="Download ${esc(f.name)}">${ICON.download}<span>Download</span></button></div>`;
    li.onclick = () => receiveOne(p, f);
    ul.append(li);
  }
}

/** What every page shows of the network: the Devices badge, "Sharing N files", the Share page's summary. */
function renderSummary() {
  const others = otherDevices();
  const forMe = others.reduce((n, p) => n + p.offers.length, 0);
  for (const badge of document.querySelectorAll("[data-devices]")) {
    badge.textContent = forMe || others.length;
    badge.hidden = !others.length;
    badge.classList.toggle("has-files", forMe > 0);
    badge.title = forMe ? `${plural(forMe, "file")} you can download` : `${plural(others.length, "device")} here`;
  }
  const pill = $("sharingPill");
  pill.hidden = !mine.size || document.body.dataset.page === "share";
  pill.innerHTML = `${ICON.people}<span>Sharing ${plural(mine.size, "file")}</span>`;
  $("teaserTitle").textContent = others.length ? `${plural(others.length, "other device")} here` : "No other device yet";
  $("teaserMeta").textContent = forMe ? `${plural(forMe, "file")} you can download` : others.length ? "Nothing shared with you yet" : "They appear here as they open Wi-Fi Drop";
  $("peersCount").textContent = others.length || "";
}

/** The other tabs of this browser: renaming in one renames them all. */
const tabs = "BroadcastChannel" in window ? new BroadcastChannel("wifi-drop") : { postMessage() {}, onmessage: null };
tabs.onmessage = (e) => {
  const name = cleanName(e.data?.name);
  if (!name) return;
  $("nameForm").hidden = true;
  renderSelf(name);
  announceName(name).catch(() => {});
};

const setOnline = (on) => {
  $("live").classList.toggle("off", !on);
  $("liveText").textContent = on ? "Online" : "Reconnecting";
  setMood(document.querySelector(".brand .mascot"), on ? "idle" : "walk"); // looking for the network
};

let deviceKey = "";
function onDevices(list) {
  peers = list;
  const self = peers.find((p) => p.did === me.did); // this device, whichever of its windows named it
  if (self) renderSelf(self.name);
  for (const p of peers) if (p.did && p.did !== me.did) knownDevices.set(p.did, p.name);
  renderPeers();
  renderSendTo();
  // The device pickers on this device's own files: only when the devices change, and not mid-choice.
  const key = peers.map((p) => `${p.did}:${p.name}`).sort().join("|");
  if (key !== deviceKey && !document.activeElement?.closest?.("#mine")) { deviceKey = key; renderMine(); }
  renderSummary();
  announcePrivate();
  renderInbox();
}

/** Join this network's room. If it can't (offline), try again in a little while. */
async function join() {
  const kind = deviceKind();
  const nick = store.get("nick");
  try {
    net = await connect({
      profile: { name: nick || defaultName(kind), named: !!nick, kind },
      iceServers: RTC.iceServers,
      onHello: (hello) => { Object.assign(me, hello); },
      onDevices,
      onSignal: (msg) => onSignal(msg).catch((err) => console.warn(err)),
      onGrant: onAccessGranted,
      onOnline: setOnline,
    });
    publish(); // this tab's files (brought back from its previous page, or shared before it joined)
  } catch (e) {
    console.warn("join", e);
    setOnline(false);
    // Opened on a plain http:// address (other than localhost): browsers switch off the encryption Wi-Fi Drop needs,
    // so it can never connect there. Say so, instead of retrying for ever.
    if (!window.isSecureContext) {
      $("liveText").textContent = "Needs https";
      $("live").title = "Open Wi-Fi Drop on its https:// address: browsers turn off the encryption it needs on plain http";
      toast("Open Wi-Fi Drop on its https:// address (your live site): browsers block the encryption it needs on plain http");
      return;
    }
    $("liveText").textContent = "Offline";
    $("live").title = "Can't reach Wi-Fi Drop right now: check the internet connection";
    toast("Couldn't reach Wi-Fi Drop: trying again…");
    setTimeout(join, 8000);
  }
}

if (!window.RTCPeerConnection) {
  $("noPeers").hidden = false;
  $("noPeers").innerHTML = "<p>This browser can't send files directly. Use Chrome, Edge, Safari or Firefox.</p>";
}
await restore(); // this tab's files, from its previous page
renderMine();
renderSendTo();
renderSummary();
await loadInfo();
join();
