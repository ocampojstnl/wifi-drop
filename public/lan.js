// The same-network check: is another device really on this Wi-Fi?
//
// Sharing a room name isn't proof enough. Phones on mobile data, offices and some internet providers (CGNAT) put
// many unrelated homes behind one public address, so strangers can end up in the same room. So once two devices are
// connected, each one looks at HOW the connection runs, and turns the other away only on clear evidence that it's
// somewhere else:
//
//   - the connection goes through a relay server;
//   - the other device's address is a carrier-shared one (100.64.0.0/10: shared by strangers);
//   - the other device is reached at a public IPv4 address that isn't this home's own (the path left the network),
//     or at a public IPv6 address outside this home's /64;
//   - or replies take far longer than any Wi-Fi.
//
// Everything else counts as the same network: a direct path between home-network addresses (192.168.x, 10.x, ...),
// a ".local" name, an address the browser keeps hidden, or a path out to this home's own router address and straight
// back in (routers that block local device names connect phones and computers that way). When the browser can't
// tell at all, the device is trusted: it already had to come from this home's internet address to be in the room.
//
// Devices that fail aren't shown, get nothing from this one (not its name, nor its files) and can't ask it for anything.

export const MAX_RTT = 0.5; // seconds; phones on Wi-Fi power saving can take a few hundred ms, the internet abroad more
export const MAX_RTT_VIA_ROUTER = 0.3; // out to the home's public address and back in

const v4 = (ip) => /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)?.slice(1).map(Number) ?? null;
const prefix64 = (ip) => {
  const [head, tail = ""] = String(ip).toLowerCase().split("%")[0].split("::");
  const a = head.split(":").filter(Boolean), b = tail.split(":").filter(Boolean);
  const full = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b].map((h) => parseInt(h, 16) || 0);
  return full.slice(0, 4).join(":");
};

/** "private" (a home network's own address), "shared" (carrier-shared), "public", or "unknown". */
export function addressKind(ip = "") {
  ip = String(ip).replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  if (!ip) return "unknown";
  if (/\.local$/i.test(ip)) return "private"; // mDNS names only resolve on the same network
  const n = v4(ip);
  if (n) {
    const [a, b] = n;
    if (a === 100 && b >= 64 && b <= 127) return "shared";
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
    return "public";
  }
  if (ip.includes(":")) return ip === "::1" || /^f[cd]|^fe[89ab]/i.test(ip) ? "private" : "public";
  return "unknown";
}

/**
 * The verdict on one connection, from its stats: true (same network), false (not), or null (can't tell yet).
 * pair: the selected candidate pair; local/remote: its two candidates; localAddresses: every address this device has.
 */
export function isLocalPath({ pair, local, remote, localAddresses = [] }) {
  if (!pair || !local || !remote) return null;
  if (local.candidateType === "relay" || remote.candidateType === "relay") return false;
  const rtt = typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime : null;
  if (rtt !== null && rtt > MAX_RTT) return false;
  const ip = String(remote.address ?? remote.ip ?? "");
  const kind = addressKind(ip);
  if (kind === "shared") return false;
  if (kind === "public") {
    const mine = localAddresses.filter((a) => addressKind(a) === "public" && String(a).includes(":") === ip.includes(":"));
    if (ip.includes(":")) {
      // Public IPv6: fine inside this home's /64.
      if (mine.length ? !mine.some((a) => prefix64(a) === prefix64(ip)) : !(rtt !== null && rtt <= 0.05)) return false;
    } else {
      // Public IPv4: only this home's own router address (out and straight back in), and quick.
      if (!mine.includes(ip) || (rtt !== null && rtt > MAX_RTT_VIA_ROUTER)) return false;
    }
  }
  return true;
}

/** Read a live RTCPeerConnection's stats and give the verdict (see isLocalPath). */
export async function checkConnection(connection) {
  if (!connection || typeof connection.getStats !== "function") return null;
  const report = await connection.getStats();
  const all = new Map();
  report.forEach((s) => all.set(s.id, s));
  let pair = null;
  for (const s of all.values()) if (s.type === "transport" && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId);
  if (!pair) for (const s of all.values()) if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair = s;
  if (!pair) return null;
  const localAddresses = [...all.values()].filter((s) => s.type === "local-candidate").map((s) => s.address ?? s.ip).filter(Boolean);
  return isLocalPath({ pair, local: all.get(pair.localCandidateId), remote: all.get(pair.remoteCandidateId), localAddresses });
}
