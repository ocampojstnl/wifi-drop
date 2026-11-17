// Which "party" a visitor belongs to, and their pass to it.
//
// Everyone who reaches the site from the same home internet connection (the same public address) is put in the same
// room, so they see each other. Nobody else does: the room's name is a secret code made from that address, and each
// visitor's pass (an Ably token) only opens their own room.
//
// Files are never part of this. The room only carries who is here, what they offer (names and sizes), and the small
// messages two devices exchange to connect directly. The files then go device to device.
import crypto from "node:crypto";
// Ably's server package (accounts on Ably's per-user pricing need it): issues tokens for the visitors' devices.
import { createHttpClient } from "@ably/pubsub-server";

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
    const full = ip.split("%")[0];
    const [head] = full.split("::");
    const parts = head.split(":").filter(Boolean);
    return `v6:${parts.slice(0, 4).join(":")}`;
  }
  return `v4:${ip}`;
}

const hash = (secret, text, len = 16) => crypto.createHmac("sha256", secret).update(text).digest("base64url").slice(0, len);

/**
 * A pass into the visitor's room.
 *  - device: a random id this browser keeps (so a device keeps its identity across reloads; a private window is new)
 *  - tab:    this tab's id (it stays the same across the site's pages)
 * The device id that others see is made from the browser's secret, so nobody can pose as another device.
 */
export async function passFor({ ip, device, tab, apiKey, secret }) {
  if (!apiKey) throw new Error("ABLY_API_KEY is not set");
  if (!/^[\w-]{16,64}$/.test(device ?? "")) throw new Error("Bad device id");
  if (!/^[\w-]{8,64}$/.test(tab ?? "")) throw new Error("Bad tab id");
  const key = secret || crypto.createHash("sha256").update(`wifi-drop|${apiKey}`).digest("hex");
  const room = hash(key, `room|${homeOf(ip)}`, 22);
  const did = hash(key, `device|${device}`);
  const clientId = `${did}~${tab}`;
  const capability = {
    // The room: see who's here and what they share (presence), but not send to everyone.
    [`room:${room}`]: ["presence", "subscribe"],
    // Any device's inbox: send it connection messages, private file lists, access requests.
    [`room:${room}:inbox:*`]: ["publish"],
    // This device's own inbox: read it.
    [`room:${room}:inbox:${did}`]: ["publish", "subscribe"],
  };
  const tokenRequest = await createHttpClient({ key: apiKey }).auth.createTokenRequest({
    clientId,
    ttl: 6 * 60 * 60 * 1000,
    capability: JSON.stringify(capability),
  });
  return { tokenRequest, room, did, clientId };
}
