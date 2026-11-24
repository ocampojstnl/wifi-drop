// Wi-Fi Drop, on this computer: serves the site exactly as Vercel does (the pages, /static, /config.json and the
// /api functions), so it can be tried before deploying. Run: npm start  (no keys or accounts needed)
//
// Two addresses:
//   http://localhost:4040        for this PC
//   https://<this PC>:4443       for phones and other devices on the Wi-Fi. Browsers only allow the encryption
//                                Wi-Fi Drop needs on secure (https) pages, so the other devices need this one. It uses
//                                a certificate made on this PC, so each device warns once: tap Advanced → Proceed.
//
// Files never pass through here, nor through Vercel or the public relays: they go straight from one browser to the other
// (WebRTC). The site only helps the devices on one network find each other.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { PAGES, PUBLIC, ROOT, renderPage, siteConfig, adsTxt, bundleTrystero } from "./lib/pages.mjs";
import room from "./api/room.js";
import qr from "./api/qr.js";

// Settings from a .env file next to this one (e.g. ROOM_SECRET=…), if there is one.
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {}

const PORT = Number(process.env.PORT) || 4040;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 4443;
let trystero = null; // the bundled library, made on first use
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

/** This computer's address on the home network, so phones can try the site too. */
function lanAddress() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Docker/i.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return null;
}
const LAN = lanAddress();
/** The address other devices open (and the one the QR code on the page shows). */
const JOIN_URL = LAN ? `https://${LAN}:${HTTPS_PORT}/` : null;

const send = (res, status, body, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
};

async function serveFile(res, file) {
  try {
    send(res, 200, await fsp.readFile(file), TYPES[path.extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found");
  }
}

async function handle(req, res) {
  const p = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (PAGES[p] && req.method === "GET") return send(res, 200, await renderPage(p), "text/html; charset=utf-8");
    if (p === "/api/room") return room(req, res);
    if (p === "/api/qr") return qr(req, res);
    if (p === "/config.json") {
      // On this computer: the ad spaces show as placeholders (ADS_PREVIEW=0 hides them), and the join code points
      // other devices at the secure address.
      const config = await siteConfig({ preview: process.env.ADS_PREVIEW !== "0" });
      return send(res, 200, JSON.stringify({ ...config, joinUrl: JOIN_URL }), "application/json");
    }
    if (p === "/ads.txt") {
      const txt = adsTxt(await siteConfig());
      return txt ? send(res, 200, txt) : send(res, 404, "Not found");
    }
    if (p === "/favicon.svg" || p === "/favicon.ico") return serveFile(res, path.join(PUBLIC, "favicon.svg"));
    if (p === "/static/vendor/trystero.js") return send(res, 200, (trystero ??= await bundleTrystero()), "text/javascript; charset=utf-8");
    if (p.startsWith("/static/")) {
      const file = path.join(PUBLIC, decodeURIComponent(p.slice("/static/".length)));
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
      return serveFile(res, file);
    }
    send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Something went wrong");
  }
}

/** A certificate for this PC's address, made once and kept in .certs/ (never uploaded: see .gitignore). */
async function certificate() {
  const dir = path.join(ROOT, ".certs");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const forFile = path.join(dir, "for.txt");
  const wanted = `localhost ${LAN ?? ""}`;
  try {
    if (fs.readFileSync(forFile, "utf8") === wanted) return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch {}
  const { default: selfsigned } = await import("selfsigned");
  const altNames = [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }];
  if (LAN) altNames.push({ type: 7, ip: LAN });
  const made = selfsigned.generate([{ name: "commonName", value: "Wi-Fi Drop (this PC)" }], {
    days: 825, keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, made.private);
  fs.writeFileSync(certFile, made.cert);
  fs.writeFileSync(forFile, wanted);
  return { key: made.private, cert: made.cert };
}

const onError = (port) => (e) => {
  if (e.code === "EADDRINUSE") console.error(`\n  Port ${port} is busy: is Wi-Fi Drop already running? (Or use other ports: set PORT=4041 and HTTPS_PORT=4444)\n`);
  else console.error(e);
  process.exit(1);
};

const plain = http.createServer(handle);
plain.on("error", onError(PORT));
const secure = https.createServer(await certificate(), handle);
secure.on("error", onError(HTTPS_PORT));

await Promise.all([
  new Promise((r) => plain.listen(PORT, "0.0.0.0", r)),
  new Promise((r) => secure.listen(HTTPS_PORT, "0.0.0.0", r)),
]);

console.log("\n  Wi-Fi Drop (local test of the website)");
console.log(`  On this PC:      http://localhost:${PORT}`);
if (JOIN_URL) {
  console.log(`  Other devices:   ${JOIN_URL}   (same Wi-Fi; or scan the QR code on the page)`);
  console.log("                   The first time, the browser warns the connection isn't private:");
  console.log("                   tap Advanced → Proceed. (It's this PC's own certificate.)");
}
console.log("  Ctrl+C stops it.\n");
if (!process.env.NO_OPEN) {
  const url = `http://localhost:${PORT}`;
  const [cmd, args] = process.platform === "win32" ? ["explorer", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
