// Vercel function: a visitor's pass into their room (see lib/room.mjs). It never sees a file.
import { clientIp, passFor } from "../lib/room.mjs";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url, "http://x");
    const pass = await passFor({
      ip: clientIp(req.headers, req.socket?.remoteAddress),
      device: url.searchParams.get("device"),
      tab: url.searchParams.get("tab"),
      apiKey: process.env.ABLY_API_KEY,
      secret: process.env.ROOM_SECRET,
    });
    res.statusCode = 200;
    res.end(JSON.stringify(pass));
  } catch (e) {
    res.statusCode = /not set/.test(e.message) ? 500 : 400;
    res.end(JSON.stringify({ error: e.message }));
  }
}
