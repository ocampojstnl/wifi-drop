// Which "party" a visitor belongs to.
//
// Everyone who reaches the site from the same home internet connection (the same public address) gets the same
// secret room name and password, so their devices find each other. Nobody else does: both are made from that address
// with a secret only this site knows (ROOM_SECRET), so they can't be worked out from outside.
//
// The devices then meet through free public relays (Nostr, via the Trystero library): only a short, encrypted
// "here's how to reach me" passes through them. After that, every device talks to the others directly, and files go
// straight from one device to another. Nothing about files ever reaches this site or the relays.
import crypto from "node:crypto";

/** The visitor's public address, as Vercel (or the local test server) saw it. */
export function clientIp(headers, socketAddress = "") {
  const forwarded = String(headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return (forwarded || String(headers["x-real-ip"] ?? "") || socketAddress).replace(/^::ffff:/, "");
}

/** A home network's addresses: 10.x, 172.16–31.x, 192.168.x, this computer, link-local (only seen when testing locally). */
function isPrivate(ip) {
  if (ip === "::1" || /^f[cd]|^fe[89ab]/i.test(ip)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * The part of an address that's the same for every device in one home. IPv4: the whole address (the router shares
 * it). IPv6: each device has its own address, but they share the first half (the home's /64 network).
 */
function homeOf(ip) {
  if (isPrivate(ip)) return "local-test-network"; // testing on the home network itself: everyone is one room
  if (ip.includes(":")) {
    const [head] = ip.split("%")[0].split("::");
    return `v6:${head.split(":").filter(Boolean).slice(0, 4).join(":")}`;
  }
  return `v4:${ip}`;
}

// Without ROOM_SECRET the site still works, but anyone who knew a home's public address and read this code could
// work out its room: set ROOM_SECRET (any long random text) in Vercel to close that.
const FALLBACK_SECRET = "wifi-drop: set ROOM_SECRET in your hosting settings";

/** The visitor's room: its name, and the password that encrypts how its devices find each other. */
export function roomFor(ip, secret = process.env.ROOM_SECRET) {
  const key = secret || FALLBACK_SECRET;
  const mac = (text, len) => crypto.createHmac("sha256", key).update(text).digest("base64url").slice(0, len);
  const home = homeOf(ip);
  return { room: mac(`room|${home}`, 22), password: mac(`password|${home}`, 32), secured: !!secret };
}
