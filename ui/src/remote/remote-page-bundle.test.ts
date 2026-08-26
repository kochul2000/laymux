import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The Rust remote server serves the committed minified artifacts, so an edit
// to the readable sources without `npm run build:remote-page` would silently
// ship a stale client (ADR-0169). The build stamps the source hashes into the
// artifact banner; this test recomputes them.
const ASSETS_DIR = path.resolve(__dirname, "../../../src-tauri/src/remote_server/assets");
const PAGE_PATH = path.resolve(ASSETS_DIR, "../page.html");

const sourceHash = (file: string): string =>
  createHash("sha256")
    .update(readFileSync(path.join(ASSETS_DIR, file)))
    .digest("hex")
    .slice(0, 16);

describe("remote page bundle", () => {
  it("committed minified artifacts match the sources", () => {
    const banner = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8").split("\n", 8);
    const stamp = banner.find((line) => line.startsWith("// Source-SHA256:"));
    expect(stamp).toBe(
      `// Source-SHA256: remote-app.js=${sourceHash("remote-app.js")}` +
        ` remote-app.css=${sourceHash("remote-app.css")}`,
    );
  });

  it("artifacts carry the do-not-edit banner", () => {
    const js = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8");
    expect(js.startsWith("// GENERATED FILE - DO NOT EDIT.")).toBe(true);
  });

  it("uses vector icons for the remote file viewer controls", () => {
    const page = readFileSync(PAGE_PATH, "utf8");

    for (const id of ["fileViewerZoomOut", "fileViewerZoomIn", "fileViewerClose"]) {
      expect(page).toMatch(new RegExp(`<button id="${id}"[^>]*>\\s*<svg\\b`));
    }
  });
});
