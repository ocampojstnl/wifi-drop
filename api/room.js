// Vercel function: the visitor's room (see lib/room.mjs). It never sees a file, nor who is in the room.
import { clientIp, roomFor } from "../lib/room.mjs";

export default function handler(req, res) {
  const { room, password } = roomFor(clientIp(req.headers, req.socket?.remoteAddress));
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify({ room, password }));
}
