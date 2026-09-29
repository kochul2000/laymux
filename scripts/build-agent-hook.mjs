import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = process.argv.includes("--release");
function run(args) {
  const result = spawnSync("cargo", args, { cwd: root, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(result.status || 1);
  }
  return result.stdout;
}
run(["build", "--locked", "-p", "laymux-agent-hook", ...(release ? ["--release"] : [])]);
const metadata = JSON.parse(run(["metadata", "--no-deps", "--format-version", "1"]));
const file = `laymux-agent-hook${process.platform === "win32" ? ".exe" : ""}`;
const destination = path.join(root, "src-tauri", "gen", "agent-hook");
mkdirSync(destination, { recursive: true });
copyFileSync(path.join(metadata.target_directory, release ? "release" : "debug", file), path.join(destination, file));
