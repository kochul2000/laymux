import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { decideLinkActivation } from "../lib/link-activation";

// The Rust remote server serves the committed minified artifacts, so an edit
// to the readable sources without `npm run build:remote-page` would silently
// ship a stale client (ADR-0169). The build stamps the source hashes into the
// artifact banner; this test recomputes them.
const ASSETS_DIR = path.resolve(__dirname, "../../../src-tauri/src/remote_server/assets");
const PAGE_PATH = path.resolve(ASSETS_DIR, "../page.html");
const APP_SOURCE_PATH = path.resolve(ASSETS_DIR, "remote-app.js");
const ICON_SOURCE_PATH = path.resolve(__dirname, "./remote-icons.js");
const CODEX_TRANSCRIPT_WHEEL_SOURCE_PATH = path.resolve(
  __dirname,
  "../lib/codex-transcript-wheel.ts",
);
const PACKAGE_LOCK_PATH = path.resolve(__dirname, "../../package-lock.json");

const sourceHash = (file: string): string =>
  createHash("sha256")
    .update(readFileSync(path.join(ASSETS_DIR, file)))
    .digest("hex")
    .slice(0, 16);

const fileHash = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

interface PackageLock {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string } | undefined>;
}

const packageInputHash = (lock: PackageLock, packageName: string): string => {
  const input = lock.packages[`node_modules/${packageName}`];
  if (!input?.version || !input.integrity) throw new Error(`Missing ${packageName} lock input`);
  return createHash("sha256")
    .update(JSON.stringify([input.version, input.resolved, input.integrity]))
    .digest("hex")
    .slice(0, 16);
};

describe("remote page bundle", () => {
  it("committed minified artifacts match the sources", () => {
    const banner = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8").split("\n", 8);
    const stamp = banner.find((line) => line.startsWith("// Source-SHA256:"));
    const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as PackageLock;
    expect(stamp).toBe(
      `// Source-SHA256: remote-app.js=${sourceHash("remote-app.js")}` +
        ` remote-app.css=${sourceHash("remote-app.css")}` +
        ` remote-icons.js=${fileHash(ICON_SOURCE_PATH)}` +
        ` codex-transcript-wheel.ts=${fileHash(CODEX_TRANSCRIPT_WHEEL_SOURCE_PATH)}` +
        ` lucide-package=${packageInputHash(lock, "lucide")}`,
    );
  });

  it("artifacts carry the do-not-edit banner", () => {
    const js = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8");
    expect(js.startsWith("// GENERATED FILE - DO NOT EDIT.")).toBe(true);
  });

  it("does not paint the browser focus outline on the initial navigation menu button", () => {
    const css = readFileSync(path.join(ASSETS_DIR, "remote-app.css"), "utf8");
    const bundledCss = readFileSync(path.join(ASSETS_DIR, "remote-app.min.css"), "utf8");

    expect(css).toMatch(/\.menu-button:focus\s*\{[^}]*outline:\s*none;/s);
    expect(bundledCss).toContain(".menu-button:focus{outline:none}");
  });

  it("routes every generic Remote pictogram through the Lucide icon boundary", () => {
    const page = readFileSync(PAGE_PATH, "utf8");
    const app = readFileSync(APP_SOURCE_PATH, "utf8");
    const icons = readFileSync(ICON_SOURCE_PATH, "utf8");

    expect(icons).toContain('from "lucide"');
    expect(page).not.toMatch(/<svg\b/);
    expect(app).not.toMatch(/<svg\b/);
    expect(app).not.toContain('dot.textContent = "●"');
    expect(app).not.toContain("status.textContent = pane.selectorStatus.icon");
    expect(app).not.toContain('"✓ Signed in');
    expect(app).not.toContain('"✓ 로그인 성공');
    expect(app).toContain('setRemoteIcon(icon, "Check", { size: 12 });');
    const shell = new DOMParser().parseFromString(page, "text/html");

    for (const id of [
      "navToggle",
      "copyPaneId",
      "statusSpinner",
      "fileExplorerHeader",
      "spatialExclusion",
      "newWorkspace",
      "hiddenWorkspaceToggle",
      "drawerNotificationsButton",
      "drawerConnectionButton",
      "drawerSettingsButton",
      "drawerBack",
      "scrollToBottom",
      "attachFile",
      "composerSend",
      "fileViewerBack",
      "fileViewerZoomOut",
      "fileViewerZoomIn",
      "fileViewerClose",
    ]) {
      expect(shell.getElementById(id)?.querySelector("[data-remote-icon]")).not.toBeNull();
    }
  });

  // ADR-0224: the Remote page cannot import the desktop mapping module, so its
  // chip action lists are a hand copy. Pin that copy to `decideLinkActivation`'s
  // Remote answers here — a drift would silently give Remote a different chip
  // (or, worse, an action ADR-0045 forbids it).
  it("keeps the Remote chip actions in step with the shared activation mapping", () => {
    const app = readFileSync(APP_SOURCE_PATH, "utf8");
    const body = app.match(/function linkChipActions\(kind\) \{([\s\S]*?)\n {8}\}/)?.[1];
    expect(body).toBeDefined();

    for (const target of ["url", "file", "directory"] as const) {
      const decided = decideLinkActivation({ mode: "chip", surface: "remote", target });
      expect(decided.kind).toBe("show-chip");
      const actions = decided.kind === "show-chip" ? decided.actions : [];
      const literal = `[${actions.map((action) => `"${action}"`).join(", ")}]`;
      expect(body).toContain(literal);
      // Remote never gets a host-process action or cwd propagation.
      for (const forbidden of ["osOpen", "osReveal", "changeDir"]) {
        expect(actions).not.toContain(forbidden);
        expect(body).not.toContain(`"${forbidden}"`);
      }
    }

    // `immediate` stays the fallback for anything that is not exactly "chip".
    expect(app).toContain('return value === "chip" ? "chip" : "immediate";');
    // The browser action must keep going through the validated opener (ADR-0162).
    expect(app).toMatch(/if \(action === "browser"\) \{[\s\S]*?openRemoteUrl\(target\.value\);/);
  });

  // The chip floats over the terminal and `pathLinkAtPoint` is a z-order-blind
  // rect test, so a chip button drawn over the next row's underline would arm a
  // press that the window-capture pointerup runs before the chip's own click.
  it("never arms a path-link press from a tap inside the chip", () => {
    const app = readFileSync(APP_SOURCE_PATH, "utf8");
    const body = app.match(/function handlePathLinkPointerDown\(event\) \{([\s\S]*?)\n {8}\}/)?.[1];
    expect(body).toBeDefined();

    const guard = body!.indexOf("if (linkChipContains(event.target)) return;");
    const hitTest = body!.indexOf("pathLinkAtPoint(");
    expect(guard).toBeGreaterThan(-1);
    // The bail must come before the underline is looked up, not after.
    expect(guard).toBeLessThan(hitTest);
  });

  // ADR-0224 §3: the chip shares the underline's lifetime judgment, and the
  // underline reads its marker's live line because scrollback trim shifts the
  // absolute numbers (`livePathLinkBufferLine`).
  it("judges chip lifetime from a marker line, not the frozen capture", () => {
    const app = readFileSync(APP_SOURCE_PATH, "utf8");

    expect(app).toContain("function registerLinkChipMarker(bufferLine)");
    expect(app).toContain("marker: registerLinkChipMarker(target.bufferLine)");
    // A live marker wins; a disposed one is fail closed rather than a fallback.
    const live = app.match(/function liveLinkChipBufferLine\(target\) \{([\s\S]*?)\n {8}\}/)?.[1];
    expect(live).toBeDefined();
    expect(live).toContain("return marker.line + 1;");
    expect(live).toMatch(/marker\.isDisposed === true[\s\S]*?return null;/);
    // The re-check reads that line, never `target.bufferLine` directly.
    const check = app.match(
      /function linkChipTokenStillOnScreen\(target\) \{([\s\S]*?)\n {8}\}/,
    )?.[1];
    expect(check).toBeDefined();
    expect(check).toContain("liveLinkChipBufferLine(target)");
    expect(check).not.toContain("target.bufferLine");
    // The marker lives exactly as long as the chip does.
    expect(app).toMatch(
      /function dismissLinkChip\(\) \{[\s\S]*?previous\?\.marker\?\.dispose\?\.\(\)/,
    );
  });

  // A one-cell capture would pass the liveness re-check on any row that happens
  // to show that single character, keeping a chip alive over an erased URL.
  it("never falls back to a single-cell URL capture", () => {
    const app = readFileSync(APP_SOURCE_PATH, "utf8");
    const body = app.match(
      /function captureUrlLinkChipTarget\(uri, point, range\) \{([\s\S]*?)\n {8}\}/,
    )?.[1];
    expect(body).toBeDefined();

    expect(body).toContain("if (!found) return null;");
    expect(body).not.toContain("found ? found.startCol : column");
    expect(body).not.toContain("found ? found.endCol : column");
    // An empty capture is no capture either.
    expect(body).toContain("if (token.length === 0) return null;");
    // And the caller must honour the null instead of showing an empty chip.
    expect(app).toMatch(/const target = captureUrlLinkChipTarget\([\s\S]*?if \(!target\) return;/);
  });

  it("keeps the desktop and Remote Lucide packages on the same icon version", () => {
    const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as PackageLock;

    expect(lock.packages["node_modules/lucide"]?.version).toBe(
      lock.packages["node_modules/lucide-react"]?.version,
    );
  });
});
