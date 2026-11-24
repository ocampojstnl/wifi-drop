// The same-network check: is another device really on this Wi-Fi?
//
// Sharing a room name isn't proof enough. Phones on mobile data, offices and some internet providers (CGNAT) put
// many unrelated homes behind one public address, so strangers can end up in the same room. So once two devices are
// connected, each one looks at HOW the connection runs, and only trusts the other if it's local:
//
//   - the path is direct between the devices' own network addresses ("host" candidates), not via the internet
//     (a "srflx" path out through the router and back) and never via a relay ("relay");
//   - the other device's address is a home-network one (192.168.x, 10.x, 172.16–31.x, IPv6 fc00::/7 or fe80::),
//     or a ".local" name (those only work on the same network), or a public IPv6 address in this device's own /64;
//   - carrier-shared addresses (100.64.0.0/10) don't count: they're shared by strangers;
//   - and the reply time is short, as it is on one Wi-Fi.
//
// Devices that fail aren't shown, get nothing from this one (not its name, nor its files) and can't ask it for anything.

export const MAX_RTT = 0.1; // seconds; one Wi-Fi is usually under 0.02

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
  if (local.candidateType !== "host") return false; // went out through the router: not on this network
  if (!["host", "prflx"].includes(remote.candidateType)) return false;
  const ip = remote.address ?? remote.ip ?? "";
  const kind = addressKind(ip);
  if (kind === "shared") return false;
  if (kind === "public") {
    // Public IPv6 is fine if it's in this home's /64; public IPv4 never is (that path left the network).
    if (!ip.includes(":")) return false;
    const mine = localAddresses.filter((a) => String(a).includes(":") && addressKind(a) === "public");
    if (mine.length ? !mine.some((a) => prefix64(a) === prefix64(ip)) : !(pair.currentRoundTripTime <= 0.03)) return false;
  }
  if (typeof pair.currentRoundTripTime === "number" && pair.currentRoundTripTime > MAX_RTT) return false;
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
