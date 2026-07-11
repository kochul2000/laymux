import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

// xterm.js #5997 / e9c648f: widening can leave stale isWrapped flags on
// retained rows. Remove this once a stable @xterm/xterm release contains it.
const target = fileURLToPath(
  new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url),
);
const original = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const patched =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";

const source = await readFile(target, "utf8");
if (source.includes(patched)) {
  process.exit(0);
}
if (!source.includes(original)) {
  throw new Error("Unsupported @xterm/xterm bundle: reflow patch target not found");
}

await writeFile(target, source.replace(original, patched), "utf8");
