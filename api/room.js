// Vercel function: the visitor's room (see lib/room.mjs). It never sees a file, nor who is in the room.
import { clientIp, roomFor } from "../lib/room.mjs";

export default function handler(req, res) {
  const v4 = new URL(req.url ?? "/", "http://x").searchParams.get("v4") ?? "";
  const { room, password } = roomFor(clientIp(req.headers, req.socket?.remoteAddress), undefined, v4.slice(0, 15));
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify({ room, password }));
}
