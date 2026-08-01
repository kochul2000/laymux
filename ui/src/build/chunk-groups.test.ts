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

  it("isolates the GitHub view from the near-limit entry chunk", () => {
    expect(resolveChunkGroup("/repo/ui/src/components/views/GitHubView.tsx")).toBe("github-view");
    expect(resolveChunkGroup("/repo/ui/src/components/views/GitHubView.test.tsx")).toBeUndefined();
  });

  it("isolates the static v3 failure coordinator from the near-limit entry chunk", () => {
    expect(resolveChunkGroup("/repo/ui/src/lib/terminal-output-v3-failure-coordinator.ts")).toBe(
      "terminal-output-v3-failure",
    );
    expect(
      resolveChunkGroup("/repo/ui/src/lib/terminal-output-v3-failure-coordinator.test.ts"),
    ).toBeUndefined();
  });

  it("isolates input delivery diagnostics from the near-limit entry chunk", () => {
    expect(resolveChunkGroup("/repo/ui/src/lib/terminal-input-delivery-metrics.ts")).toBe(
      "terminal-input-delivery-metrics",
    );
    expect(
      resolveChunkGroup("/repo/ui/src/lib/terminal-input-delivery-metrics.test.ts"),
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

  it.each([
    "/repo/ui/src/components/widgets/registry.ts",
    "/repo/ui/src/components/widgets/ClaudeUsageWidget.tsx",
    "/repo/ui/src/components/views/settings/WidgetsSection.tsx",
    "/repo/ui/src/components/layout/StatusLine.tsx",
    "/repo/ui/src/lib/widget-placement.ts",
  ])("keeps the widget feature out of the near-limit entry chunk: %s", (id) => {
    expect(resolveChunkGroup(id)).toBe("widgets");
  });

  it.each([
    "/repo/ui/src/lib/usage-rows.ts",
    "/repo/ui/src/lib/usage-status.ts",
    "/repo/ui/src/lib/codex-usage-subscription.ts",
    "/repo/ui/src/hooks/useUsageSnapshot.ts",
    "/repo/ui/src/hooks/useCodexUsageSnapshot.ts",
  ])("groups the usage data layer shared by views and widgets: %s", (id) => {
    expect(resolveChunkGroup(id)).toBe("usage");
  });

  it("claims only the widgets settings section, not every future settings section", () => {
    expect(
      resolveChunkGroup("/repo/ui/src/components/views/settings/SomeOtherSection.tsx"),
    ).toBeUndefined();
  });

  it("normalizes Windows separators for the widget group", () => {
    expect(resolveChunkGroup("D:\\repo\\ui\\src\\components\\widgets\\registry.ts")).toBe(
      "widgets",
    );
  });
});
