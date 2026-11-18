// Builds the site for Vercel into dist/: one HTML file per page, the static files under /static, the browser's
// settings (config.json), and ads.txt once there's an AdSense publisher id. Run: npm run build
import fs from "node:fs/promises";
import path from "node:path";
import { PAGES, PUBLIC, ROOT, renderPage, siteConfig, adsTxt, bundleTrystero } from "./lib/pages.mjs";

const DIST = path.join(ROOT, "dist");
await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

// Pages: / → index.html, /devices → devices.html (Vercel serves it at /devices).
for (const pathname of Object.keys(PAGES)) {
  const file = pathname === "/" ? "index.html" : `${pathname.slice(1)}.html`;
  await fs.writeFile(path.join(DIST, file), await renderPage(pathname));
}

// Static files (styles, scripts, fonts), plus Trystero (finds the other devices) bundled for browsers.
await fs.cp(PUBLIC, path.join(DIST, "static"), { recursive: true, filter: (src) => !src.includes(`${path.sep}pages`) && !src.endsWith("layout.html") });
await fs.mkdir(path.join(DIST, "static", "vendor"), { recursive: true });
await fs.writeFile(path.join(DIST, "static", "vendor", "trystero.js"), await bundleTrystero());
await fs.copyFile(path.join(PUBLIC, "favicon.svg"), path.join(DIST, "favicon.svg"));

const config = await siteConfig();
await fs.writeFile(path.join(DIST, "config.json"), JSON.stringify(config));
const ads = adsTxt(config);
if (ads) await fs.writeFile(path.join(DIST, "ads.txt"), ads);

console.log(`Built ${Object.keys(PAGES).length} pages into dist/${ads ? " (with ads.txt)" : ""}`);
