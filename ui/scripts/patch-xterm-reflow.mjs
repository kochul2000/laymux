import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

// xterm.js #5997 / e9c648f: widening can leave stale isWrapped flags on
// retained rows. Remove this once a stable @xterm/xterm release contains it.
const moduleTarget = fileURLToPath(
  new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url),
);
const commonJsTarget = fileURLToPath(
  new URL("../node_modules/@xterm/xterm/lib/xterm.js", import.meta.url),
);
const original = "m>0&&(o.push(l+h.length-m),o.push(m)),l+=h.length-1";
const patched =
  "m>0&&(h[c].isWrapped=!1,u&&(u.isWrapped=!1),o.push(l+h.length-m),o.push(m)),l+=h.length-1";
// xterm 6.0.0 CoreService treats disableStdin as a blanket onData gate, which
// also drops parser-generated OSC/DSR replies. Preserve the user-input gate but
// allow protocol replies (`wasUserInput === false`) to reach Terminal.onData.
const disableStdinOriginal = "if(this._optionsService.rawOptions.disableStdin)return;";
const moduleDisableStdinPatched = "if(this._optionsService.rawOptions.disableStdin&&i)return;";
const commonJsDisableStdinPatched = "if(this._optionsService.rawOptions.disableStdin&&t)return;";

async function patchBundle(target, replacements) {
  const source = await readFile(target, "utf8");
  let next = source;
  for (const { name, originalText, patchedText } of replacements) {
    if (next.includes(patchedText)) continue;
    if (!next.includes(originalText)) {
      throw new Error(`Unsupported @xterm/xterm bundle: ${name} patch target not found`);
    }
    next = next.replace(originalText, patchedText);
  }

  if (next !== source) {
    await writeFile(target, next, "utf8");
  }
}

await patchBundle(moduleTarget, [
  { name: "reflow", originalText: original, patchedText: patched },
  {
    name: "disableStdin",
    originalText: disableStdinOriginal,
    patchedText: moduleDisableStdinPatched,
  },
]);
await patchBundle(commonJsTarget, [
  {
    name: "disableStdin",
    originalText: disableStdinOriginal,
    patchedText: commonJsDisableStdinPatched,
  },
]);
