// Wi-Fi Drop, on this computer: serves the site exactly as Vercel does (the pages, /static, /config.json and the
// /api functions), so it can be tried before deploying. Run: npm start  (needs ABLY_API_KEY, e.g. in a .env file)
//
// Files never pass through here, nor through Vercel or Ably: they go straight from one browser to the other
// (WebRTC). The site only helps the devices on one network find each other.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { PAGES, PUBLIC, ROOT, renderPage, siteConfig, adsTxt } from "./lib/pages.mjs";
import token from "./api/token.js";
import qr from "./api/qr.js";

// Settings from a .env file next to this one (ABLY_API_KEY=…), if there is one.
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {}

const PORT = Number(process.env.PORT) || 4040;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

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

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (PAGES[p] && req.method === "GET") return send(res, 200, await renderPage(p), "text/html; charset=utf-8");
    if (p === "/api/token") return token(req, res);
    if (p === "/api/qr") return qr(req, res);
    // On this computer the ad spaces always show as placeholders, to see where the ads go (ADS_PREVIEW=0 hides them).
    if (p === "/config.json") return send(res, 200, JSON.stringify(await siteConfig({ preview: process.env.ADS_PREVIEW !== "0" })), "application/json");
    if (p === "/ads.txt") {
      const txt = adsTxt(await siteConfig());
      return txt ? send(res, 200, txt) : send(res, 404, "Not found");
    }
    if (p === "/favicon.svg" || p === "/favicon.ico") return serveFile(res, path.join(PUBLIC, "favicon.svg"));
    if (p === "/static/vendor/ably.min.js") return serveFile(res, path.join(ROOT, "node_modules", "ably", "build", "ably.min.js"));
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
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`\n  Port ${PORT} is busy: is Wi-Fi Drop already running? (Or use another: set PORT=4041)\n`);
  else console.error(e);
  process.exit(1);
});

/** This computer's address on the home network, so phones can try the site too. */
function lanAddress() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Docker/i.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return null;
}

server.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddress();
  console.log("\n  Wi-Fi Drop (local test of the website)");
  console.log(`  On this PC:     http://localhost:${PORT}`);
  if (lan) console.log(`  Other devices:  http://${lan}:${PORT}`);
  if (!process.env.ABLY_API_KEY) console.log("\n  ! ABLY_API_KEY is not set: put it in a .env file next to server.mjs (see README).");
  console.log("  Ctrl+C stops it.\n");
  if (!process.env.NO_OPEN) {
    const url = `http://localhost:${PORT}`;
    const [cmd, args] = process.platform === "win32" ? ["explorer", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
});
