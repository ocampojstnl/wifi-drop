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
  // Google AdSense's ownership tag, once there's a publisher id in ads.json (Google looks for it before approving).
  const client = (await siteConfig()).ads?.client ?? "";
  const adsMeta = /^ca-pub-\d{10,20}$/.test(client) ? `\n  <meta name="google-adsense-account" content="${client}" />` : "";
  return layout
    .replace("</title>", `</title>${adsMeta}`)
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
  // No relay (TURN) on purpose: Wi-Fi Drop only trusts direct local connections (see public/lan.js), so a relayed
  // connection would be refused anyway, and file data never goes through a third party.
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
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
    bundle: true, format: "esm", minify: true, platform: "browser", target: BROWSERS, write: false, logLevel: "warning",
    banner: { js: POLYFILLS },
  });
  return out.outputFiles[0].text;
}

/**
 * Older browsers (tablets and phones a few years behind, built-in browsers like Huawei's or Samsung's) stop at newer
 * JavaScript syntax and run nothing. The browser code is rewritten for them: these are the oldest versions that can
 * run Wi-Fi Drop at all (they have modules and WebRTC data channels).
 */
export const BROWSERS = ["chrome69", "edge79", "firefox68", "safari13"];

/**
 * Newer browser features Trystero and app.js use that older browsers lack (rewriting the syntax doesn't add them).
 * Promise.withResolvers above all: only Chrome 119+ / Safari 17.4+ have it, and without it connecting fails on any
 * tablet or phone a little behind ("Offline, trying again"). Runs first, at the top of /static/vendor/trystero.js.
 */
const POLYFILLS = `(function(){
if(!Promise.withResolvers)Promise.withResolvers=function(){var a,b,p=new this(function(r,j){a=r;b=j});return{promise:p,resolve:a,reject:b}};
if(!Promise.allSettled)Promise.allSettled=function(l){return Promise.all(Array.from(l,function(p){return Promise.resolve(p).then(function(v){return{status:"fulfilled",value:v}},function(e){return{status:"rejected",reason:e}})}))};
if(!Object.hasOwn)Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k)};
if(typeof queueMicrotask!=="function")self.queueMicrotask=function(f){Promise.resolve().then(f)};
var at=function(i){i=Math.trunc(i)||0;if(i<0)i+=this.length;return i<0||i>=this.length?undefined:this[i]};
[Array,String,Object.getPrototypeOf(Int8Array)].forEach(function(C){if(C&&!C.prototype.at)Object.defineProperty(C.prototype,"at",{value:at,writable:true,configurable:true})});
if(!String.prototype.replaceAll)String.prototype.replaceAll=function(s,r){return s instanceof RegExp?this.replace(s,r):this.split(s).join(r)};
if(self.crypto&&!crypto.randomUUID&&crypto.getRandomValues)crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=Array.from(b,function(x){return(x+256).toString(16).slice(1)}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)};
})();`;
export async function lowerJs(code) {
  const { transform } = await import("esbuild");
  return (await transform(code, { format: "esm", target: BROWSERS, loader: "js" })).code;
}
