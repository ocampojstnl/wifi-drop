// Vercel function: the QR code for the site's address, so another device can open it by pointing its camera.
import QRCode from "qrcode";

export default async function handler(req, res) {
  const text = new URL(req.url, "http://x").searchParams.get("text") ?? "";
  if (!text || text.length > 300) {
    res.statusCode = 400;
    return res.end("No text");
  }
  res.setHeader("content-type", "image/svg+xml");
  res.setHeader("cache-control", "public, max-age=86400");
  res.statusCode = 200;
  res.end(await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
}
