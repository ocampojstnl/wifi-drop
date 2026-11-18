// The site's pages. Each is a full page load (with its own ads): public/layout.html around public/pages/<name>.html.
// The app runs on all of them, so a device stays in the room and keeps sharing whichever page it's on.
// Used by build.mjs (for Vercel) and by server.mjs (to try the site on this computer).
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC = path.join(ROOT, "public");

/** Address → [file in public/pages, menu label]. In menu order. */
export const PAGES = {
  "/": ["share", "Share"],
  "/devices": ["devices", "Devices"],
  "/how-it-works": ["how-it-works", "How it works"],
  "/privacy": ["privacy", "Privacy"],
  "/help": ["help", "Help"],
};

const inlineAd = (n) => `<div class="ad ad-inline" data-ad="ad${n}" hidden><span class="ad-label">Advertisement</span><div class="ad-body"></div></div>`;

export async function renderPage(pathname) {
  const [file] = PAGES[pathname];
  const [layout, body] = await Promise.all([
    fsp.readFile(path.join(PUBLIC, "layout.html"), "utf8"),
    fsp.readFile(path.join(PUBLIC, "pages", `${file}.html`), "utf8"),
  ]);
  // The page's first line: <!-- title: … | description: … -->
  const meta = /^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\s*/s.exec(body);
  const content = (meta ? body.slice(meta[0].length) : body).replace("{{ad2}}", inlineAd(2)).replace("{{ad3}}", inlineAd(3));
  const nav = Object.entries(PAGES)
    .map(([href, [, label]]) => `<a href="${href}" data-nav${href === pathname ? ' aria-current="page"' : ""}>${label}${href === "/devices" ? '<span class="nav-badge" data-devices hidden></span>' : ""}</a>`)
    .join("");
  const fill = { title: meta?.[1] ?? "Wi-Fi Drop", description: meta?.[2] ?? "", page: file, nav, content };
  return layout
    .replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m)
    // The desktop icon of this page shows as selected.
    .replace(`<a class="desk-icon" href="${pathname}"`, `<a class="desk-icon" href="${pathname}" aria-current="page"`);
}

/** What the browser needs to know: the ad settings (ads.json) and how devices find a way to each other. */
export async function siteConfig({ preview } = {}) {
  let ads = null;
  try {
    const a = JSON.parse(await fsp.readFile(path.join(ROOT, "ads.json"), "utf8"));
    const slots = {};
    for (const k of ["ad1", "ad2", "ad3", "ad4"]) slots[k] = String(a.slots?.[k] ?? "").trim();
    // Placeholders show where the ads go: always when trying the site on this computer, on the live site only if
    // ads.json asks for them.
    ads = { client: String(a.client ?? "").trim(), slots, preview: preview ?? a.preview === true };
  } catch {}
  // Free public helpers that tell a device its address as others see it, so two devices can connect directly.
  // A relay (TURN) for strict networks can be added with TURN_URL / TURN_USERNAME / TURN_CREDENTIAL.
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return { ads, iceServers };
}

/** ads.txt: Google checks it to confirm the site is yours (only once there's a publisher id in ads.json). */
export function adsTxt(config) {
  const pub = /^ca-(pub-\d{10,20})$/.exec(config.ads?.client ?? "")?.[1];
  return pub ? `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n` : null;
}

/**
 * Trystero (finds the other devices on the network through public relays), bundled into one browser file:
 * /static/vendor/trystero.js. It's built from the npm package, so it updates with package.json.
 */
export async function bundleTrystero() {
  const { build } = await import("esbuild");
  const out = await build({
    stdin: { contents: `export { joinRoom, getRelaySockets } from "trystero";`, resolveDir: ROOT },
    bundle: true, format: "esm", minify: true, platform: "browser", target: "es2020", write: false, logLevel: "warning",
  });
  return out.outputFiles[0].text;
}
