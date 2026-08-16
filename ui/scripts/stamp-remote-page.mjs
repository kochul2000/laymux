// Prepends the generated-file banner to the minified Remote page artifacts
// (ADR-0169). Runs after `vite build --config vite.remote-page.config.ts`
// because the minifier strips banner comments from the bundle itself.
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/src/remote_server/assets",
);

const sourceHash = (file) =>
  createHash("sha256")
    .update(readFileSync(path.join(ASSETS_DIR, file)))
    .digest("hex")
    .slice(0, 16);

const lines = [
  "GENERATED FILE - DO NOT EDIT.",
  "Sources: src-tauri/src/remote_server/assets/remote-app.{js,css}",
  "Rebuild: cd ui && npm run build:remote-page",
  `Source-SHA256: remote-app.js=${sourceHash("remote-app.js")} remote-app.css=${sourceHash("remote-app.css")}`,
  "Drift from the sources is caught by ui/src/remote/remote-page-bundle.test.ts",
];

const stamp = (file, banner) => {
  const target = path.join(ASSETS_DIR, file);
  writeFileSync(target, banner + "\n" + readFileSync(target, "utf8"));
};

stamp("remote-app.min.js", lines.map((line) => `// ${line}`).join("\n"));
stamp("remote-app.min.css", `/*\n${lines.map((line) => ` * ${line}`).join("\n")}\n */`);
console.log("stamped remote-app.min.{js,css}");
