// The GUI carries the same xterm 6.0.0 reflow correction (#5997/e9c648f).
// Fail closed on an unreviewed package/version instead of silently drifting.
import { readFile, writeFile } from "node:fs/promises";
const packagePath = new URL("node_modules/@xterm/headless/package.json", import.meta.url);
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
if (metadata.version !== "6.0.0") throw new Error("Review the daemon xterm reflow adapter before changing version");
const file = new URL("node_modules/@xterm/headless/lib-headless/xterm-headless.js", import.meta.url);
const original = "g>0&&(a.push(h+u.length-g),a.push(g)),h+=u.length-1";
const legacy = "g>0&&(u[d].isWrapped=!1,l&&(l.isWrapped=!1),a.push(h+u.length-g),a.push(g)),h+=u.length-1";
// A group that still spans multiple retained rows keeps its continuation flag.
const patched = "g>0&&(u[d].isWrapped=d>0,l&&(l.isWrapped=!1),a.push(h+u.length-g),a.push(g)),h+=u.length-1";
const source = await readFile(file, "utf8");
if (source.split(patched).length === 2) {
  if (source.includes(original)) throw new Error("Ambiguous daemon xterm reflow patch");
} else {
  const anchor = source.includes(legacy) ? legacy : original;
  if (source.split(anchor).length !== 2) throw new Error("Daemon xterm reflow patch anchor changed");
  await writeFile(file, source.replace(anchor, patched));
}
