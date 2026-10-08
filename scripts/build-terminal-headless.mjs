import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!existsSync(path.join(root, "tools/terminal-headless/node_modules/esbuild/lib/main.js"))) {
  const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
    cwd: path.join(root, "tools/terminal-headless"), windowsHide: true,
    shell: process.platform === "win32", stdio: "inherit",
  });
  if (installed.error || installed.status !== 0) throw new Error("Headless parser dependency installation failed");
}
await import("../tools/terminal-headless/patch-xterm-headless.mjs");
await import("../tools/terminal-headless/patch-serialize.mjs");
const { build } = await import("../tools/terminal-headless/node_modules/esbuild/lib/main.js");
const output = path.join(root, "src-tauri/gen/headless");
mkdirSync(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "tools/terminal-headless/worker.mjs")],
  outfile: path.join(output, "worker.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: true,
  legalComments: "eof",
});
if (process.argv.includes("--runtime")) await import("./stage-terminal-node.mjs");
