// Drip, Wi-Fi Drop's mascot: a little pixel water droplet with feet.
//
// Drawn on a 14 × 16 pixel grid, in layers (body, eyes, mouth, feet, extras). Each mood shows a different set of
// layers, and style.css animates them: Drip bobs and blinks when idle, walks (carrying a file) during a transfer,
// jumps when it's done, and sheds a tear when it fails.
//
//   mascot("idle" | "walk" | "carry" | "happy" | "sad", { size })   → HTML for one Drip
//   setMood(element, mood)                                          → change an existing Drip's mood

// One letter per pixel: O outline, B body, L light, P cheek, W paper, D paper lines, T tear, Y spark, R open mouth.
const BODY = [
  "......OO......",
  ".....OBBO.....",
  ".....OBBO.....",
  "....OBBBBO....",
  "...OBLBBBBO...",
  "..OBLLBBBBBO..",
  "..OBLBBBBBBO..",
  ".OBBBBBBBBBBO.",
  ".OBBBBBBBBBBO.",
  ".OBBBBBBBBBBO.",
  ".OBPBBBBBBPBO.",
  ".OBBBBBBBBBBO.",
  "..OBBBBBBBBO..",
  "...OOOOOOOO...",
];

/** Layers: [name, rows, top row]. The rows are laid over the grid from that row down. */
const LAYERS = [
  ["eyes-open", ["....O....O....", "....O....O...."], 8],
  ["eyes-blink", ["..............", "...OO....OO..."], 8],
  ["eyes-happy", ["....O....O....", "...O.O..O.O..."], 8],
  ["eyes-sad", ["...O......O...", "....O....O....", "....T........."], 8],
  ["mouth-smile", ["......OO......"], 11],
  ["mouth-open", ["......OO......", "......RR......"], 11],
  ["mouth-sad", [".....O..O.....", "......OO......"], 11],
  ["feet-stand", ["...OO....OO..."], 14],
  ["feet-a", ["..OO......OO.."], 14],
  ["feet-b", ["....OO..OO...."], 14],
  ["sparks", ["Y............Y", "..............", ".............."], 1],
  ["sparks2", ["..............", "Y..............", "............Y."], 4],
  // A file balanced on its head, while it carries one across.
  ["paper", ["....OOOOO.....", "....OWWWOO....", "....OWDDWO....", "....OWWWWO....", "....OWDDWO....", "....OOOOOO...."], -6],
];

function rects(rows, top) {
  let out = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x];
      if (c === ".") { x++; continue; }
      let w = 1;
      while (row[x + w] === c) w++; // one rect per run of the same colour
      out += `<rect class="c${c}" x="${x}" y="${top + y}" width="${w}" height="1"/>`;
      x += w;
    }
  });
  return out;
}

const SVG = `<svg viewBox="0 -7 14 23" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  <g class="m-body">${rects(BODY, 0)}${LAYERS.filter(([n]) => !n.startsWith("feet") && !n.startsWith("sparks")).map(([n, r, t]) => `<g class="m-${n}">${rects(r, t)}</g>`).join("")}</g>
  ${LAYERS.filter(([n]) => n.startsWith("feet") || n.startsWith("sparks")).map(([n, r, t]) => `<g class="m-${n}">${rects(r, t)}</g>`).join("")}
</svg>`;

/** One Drip. size: how many screen pixels per art pixel. */
export function mascot(mood = "idle", { size = 3, label = "" } = {}) {
  return `<span class="mascot" data-mood="${mood}" style="--px:${size}px"${label ? ` role="img" aria-label="${label}"` : ""}>${SVG}</span>`;
}

export function setMood(el, mood) {
  if (el && el.dataset.mood !== mood) el.dataset.mood = mood;
}
