// Build-time download only. Production never executes a user's PATH Node.
import { mkdir, readFile, writeFile, rename, chmod, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const NODE_VERSION = "24.21.0";
const LICENSE_SHA256 = "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace";
const artifacts = {
  "win32-x64": ["win-x64/node.exe", "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32"],
  "win32-arm64": ["win-arm64/node.exe", "dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7"],
  "linux-x64": ["node-v24.21.0-linux-x64.tar.gz", "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"],
  "linux-arm64": ["node-v24.21.0-linux-arm64.tar.gz", "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = fileURLToPath(new URL("../src-tauri/gen/headless/", import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const artifact = artifacts[platform];
if (!artifact) throw new Error(`Unsupported daemon Node target: ${platform}`);
await mkdir(directory, { recursive: true });
const binary = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
const receiptPath = path.join(directory, "node-runtime.json");
let cached = false;
try {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  cached = receipt.version === NODE_VERSION && receipt.platform === platform &&
    receipt.archiveSha256 === artifact[1] && hash(await readFile(binary)) === receipt.binarySha256;
} catch { /* missing or corrupt cache is rebuilt from the pinned artifact */ }
if (!cached) {
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${artifact[0]}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 150 * 1024 * 1024 || hash(archive) !== artifact[1]) throw new Error("Pinned Node checksum mismatch");
  let bytes = archive;
  if (process.platform === "linux") {
    const temporary = await mkdtemp(path.join(directory, ".node-stage-"));
    try {
      const file = path.join(temporary, "node.tar.gz");
      await writeFile(file, archive);
      const result = spawnSync("tar", ["-xzf", file, "-C", temporary, `node-v${NODE_VERSION}-${platform}/bin/node`], { windowsHide: true, stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error("Node archive extraction failed");
      bytes = await readFile(path.join(temporary, `node-v${NODE_VERSION}-${platform}/bin/node`));
    } finally {
      // mkdtemp is created under the fixed owned generated directory.
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await writeFile(binary + ".tmp", bytes);
  if (process.platform === "linux") await chmod(binary + ".tmp", 0o755);
  await rename(binary + ".tmp", binary);
  await writeFile(receiptPath, JSON.stringify({ version: NODE_VERSION, platform, archiveSha256: artifact[1], binarySha256: hash(bytes) }, null, 2) + "\n");
}
const licensePath = path.join(directory, "Node-LICENSE.txt");
let licenseCached = false;
try { licenseCached = hash(await readFile(licensePath)) === LICENSE_SHA256; } catch { /* first build */ }
if (!licenseCached) {
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!license.ok) throw new Error("Node runtime license download failed");
  const bytes = Buffer.from(await license.arrayBuffer());
  if (hash(bytes) !== LICENSE_SHA256) throw new Error("Pinned Node runtime license checksum mismatch");
  await writeFile(licensePath, bytes);
}
process.stdout.write(`Pinned daemon Node v${NODE_VERSION} (${platform}) verified\n`);
