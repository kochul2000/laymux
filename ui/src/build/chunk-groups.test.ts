import { describe, expect, it } from "vitest";
import { resolveChunkGroup } from "./chunk-groups";

describe("resolveChunkGroup", () => {
  it.each([
    "/repo/ui/src/components/views/SettingsView.tsx",
    String.raw`C:\repo\ui\src\components\views\SettingsView.tsx`,
  ])("isolates the large Settings view on every host path format", (id) => {
    expect(resolveChunkGroup(id)).toBe("settings-view");
  });

  it("does not move similarly named source or test modules", () => {
    expect(
      resolveChunkGroup("/repo/ui/src/components/views/SettingsView.test.tsx"),
    ).toBeUndefined();
    expect(
      resolveChunkGroup("/repo/ui/src/components/views/NestedSettingsView.tsx"),
    ).toBeUndefined();
  });

  it("isolates the static v3 failure coordinator from the near-limit entry chunk", () => {
    expect(resolveChunkGroup("/repo/ui/src/lib/terminal-output-v3-failure-coordinator.ts")).toBe(
      "terminal-output-v3-failure",
    );
    expect(
      resolveChunkGroup("/repo/ui/src/lib/terminal-output-v3-failure-coordinator.test.ts"),
    ).toBeUndefined();
  });

  it.each([
    ["/repo/ui/node_modules/@xterm/xterm/lib/xterm.js", "xterm"],
    ["/repo/ui/node_modules/html2canvas/dist/html2canvas.js", "html2canvas"],
    ["/repo/ui/node_modules/i18next/dist/esm/i18next.js", "i18n"],
    ["/repo/ui/node_modules/react-i18next/dist/es/index.js", "i18n"],
    ["/repo/ui/node_modules/react/index.js", "react"],
    ["/repo/ui/node_modules/react-dom/client.js", "react"],
  ])("preserves the existing %s vendor split", (id, expected) => {
    expect(resolveChunkGroup(id)).toBe(expected);
  });

  it("leaves small vendors and other app modules to the bundler", () => {
    expect(resolveChunkGroup("/repo/ui/node_modules/zustand/esm/index.mjs")).toBeUndefined();
    expect(resolveChunkGroup("/repo/ui/src/components/views/TerminalView.tsx")).toBeUndefined();
  });
});
