// End to end, through the real public relays: two separate browsers on this computer act as two devices.
// A shares a file; B must see A (the same-network check passes), see the file in "Shared with you", download it,
// and get it intact. Needs Google Chrome or Microsoft Edge, and an internet connection (to reach the relays).
// Run: npm run test:e2e        (set CHROME=<path to chrome> if it isn't found)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4141, HTTPS_PORT = 4554, BASE = `http://127.0.0.1:${PORT}`;
const SIZE = 3 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { const v = await fn(); if (v) return v; } return null; };

const CHROME = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error("Chrome or Edge not found: set CHROME=<path>"); process.exit(2); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wifi-drop-e2e-"));
const children = [];
const logs = []; // what the pages wrote to the console, shown if a check fails
const cleanup = () => { for (const c of children) try { c.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };

async function startServer() {
  const srv = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: "1", ADS_PREVIEW: "0" }, stdio: ["ignore", "ignore", "inherit"] });
  children.push(srv);
  if (!(await until(() => fetch(BASE + "/api/room").then((r) => r.ok, () => false), 20000))) throw new Error("the test server didn't start");
}

async function browser(name, port) {
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, name)}`, "about:blank"], { stdio: "ignore" });
  children.push(proc);
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch { return null; } }, 20000);
  if (!target) throw new Error("Chrome didn't start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let n = 0; const waits = new Map(); const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m.result ?? m.error); waits.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") logs.push(`${name}: ${m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300)}`);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const cmd = (method, params = {}) => new Promise((r) => { const id = ++n; waits.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cmd("Runtime.enable"); await cmd("Page.enable");
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const js = async (expression) => (await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  return { js, errors, go: async (p) => { await cmd("Page.navigate", { url: BASE + p }); await sleep(2500); }, reload: async () => { await cmd("Page.reload", {}); await sleep(2500); } };
}

let failed = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`); if (!ok) failed++; };

try {
  await startServer();
  const A = await browser("A", 9461), B = await browser("B", 9462);
  await A.go("/"); await B.go("/");
  await A.js(`document.getElementById("nameInput").value = "Alice's laptop"; document.getElementById("nameForm").requestSubmit();`);
  await B.js(`document.getElementById("nameInput").value = "Bob's PC"; document.getElementById("nameForm").requestSubmit();`);

  // A shares a file with known content.
  await A.js(`(() => { const bytes = new Uint8Array(${SIZE}); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "holiday-video.mp4", { type: "video/mp4" }));
    const p = document.getElementById("pick"); p.files = dt.files; p.dispatchEvent(new Event("change")); })()`);

  const started = Date.now();
  const seen = await until(() => B.js(`document.querySelectorAll("#inbox .file").length`), 45000);
  check(!!seen, "B finds A through the relays and the same-network check", seen ? `${((Date.now() - started) / 1000).toFixed(1)}s` : "not within 45s");
  check(/Online|Live/i.test(await A.js(`document.getElementById("liveText").textContent`)), "A is online", await A.js(`document.getElementById("liveText").textContent`));
  const inbox = await B.js(`[...document.querySelectorAll("#inbox .file .name")].map((e) => e.textContent).join(", ")`);
  check(/holiday-video\.mp4/.test(inbox), "the file is in B's Shared with you", inbox);
  const names = await B.js(`[...document.querySelectorAll("#here .here-name")].map((e) => e.textContent.trim()).join(" | ")`);
  check(/Alice/.test(names), "B lists Alice's laptop on this Wi-Fi", names);

  // B downloads it (kept in memory, as on a phone: headless Chrome can't show a save dialog).
  await B.js(`window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; [...document.querySelectorAll("#inbox .file")].find((f) => /holiday-video/.test(f.textContent))?.querySelector(".download")?.click()`);
  const status = await until(async () => { const s = await B.js(`[...document.querySelectorAll("#transfers .up-pct")].map((e) => e.textContent).join(" | ")`); return /Received|Couldn't|Stopped|Incomplete/.test(s) && s; }, 40000);
  check(/Received/.test(status || ""), "B receives the file", status || "no result within 40s");
  const intact = await B.js(`(async () => { const a = document.querySelector("#transfers .up-actions a"); if (!a) return "no file";
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let ok = buf.length === ${SIZE};
    for (let i = 0; ok && i < buf.length; i += 997) ok = buf[i] === ((i * 31 + 7) & 255); return (ok ? "intact" : "CORRUPT") + ", " + buf.length + " bytes"; })()`);
  check(/^intact/.test(intact), "the file arrives intact", intact);
  // A reloads the page (as with pull-to-refresh): its file must still be shared afterwards, and B must see it again.
  await A.reload();
  const mineAfter = await A.js(`[...document.querySelectorAll("#mine .file")].map((e) => e.textContent).join(" ")`);
  check(/holiday-video/.test(mineAfter || ""), "A still shares the file after reloading", mineAfter ? "" : "gone from You’re sharing");
  const back = await until(() => B.js(`[...document.querySelectorAll("#inbox .file .name")].some((e) => /holiday-video/.test(e.textContent))`), 30000);
  check(!!back, "B sees the file again after A reloads");
  check(!A.errors.length && !B.errors.length, "no page errors", [...A.errors, ...B.errors].join(" / ").slice(0, 300));
} catch (e) {
  check(false, "test run", e.message);
} finally {
  cleanup();
}
if (failed && logs.length) console.log("\nPage console:\n  " + logs.slice(-20).join("\n  "));
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
setTimeout(() => process.exit(failed ? 1 : 0), 300);
