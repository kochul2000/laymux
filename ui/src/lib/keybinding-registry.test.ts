import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock settings store before importing the module under test
const mockGetState = vi.fn();
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}));

import { DEFAULT_KEYBINDINGS, matchesKeybinding, resolveKeybinding } from "./keybinding-registry";

function makeKeyEvent(
  key: string,
  opts: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
  } as unknown as KeyboardEvent;
}

describe("keybinding-registry", () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ keybindings: [] });
  });

  describe("DEFAULT_KEYBINDINGS", () => {
    it("should have unique ids", () => {
      const ids = DEFAULT_KEYBINDINGS.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("should include fileExplorer.copy", () => {
      expect(DEFAULT_KEYBINDINGS.find((d) => d.id === "fileExplorer.copy")).toBeDefined();
    });

    it("should include issueReporter.submit", () => {
      expect(DEFAULT_KEYBINDINGS.find((d) => d.id === "issueReporter.submit")).toBeDefined();
    });
  });

  describe("resolveKeybinding", () => {
    it("should return default keys when no override", () => {
      expect(resolveKeybinding("fileExplorer.copy")).toBe("Ctrl+C");
    });

    it("should return user override when present", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "fileExplorer.copy", keys: "Ctrl+Shift+C" }],
      });
      expect(resolveKeybinding("fileExplorer.copy")).toBe("Ctrl+Shift+C");
    });

    it("should return undefined for unknown action", () => {
      expect(resolveKeybinding("unknown.action")).toBeUndefined();
    });
  });

  describe("matchesKeybinding", () => {
    it("should match Ctrl+C to fileExplorer.copy", () => {
      const e = makeKeyEvent("c", { ctrl: true });
      expect(matchesKeybinding(e, "fileExplorer.copy")).toBe(true);
    });

    it("should not match Ctrl+C when shift is also held", () => {
      const e = makeKeyEvent("c", { ctrl: true, shift: true });
      expect(matchesKeybinding(e, "fileExplorer.copy")).toBe(false);
    });

    it("should match Ctrl+Enter to issueReporter.submit", () => {
      const e = makeKeyEvent("Enter", { ctrl: true });
      expect(matchesKeybinding(e, "issueReporter.submit")).toBe(true);
    });

    it("should not match plain Enter to issueReporter.submit", () => {
      const e = makeKeyEvent("Enter");
      expect(matchesKeybinding(e, "issueReporter.submit")).toBe(false);
    });

    it("should match Ctrl+Alt+N to workspace.new", () => {
      const e = makeKeyEvent("n", { ctrl: true, alt: true });
      expect(matchesKeybinding(e, "workspace.new")).toBe(true);
    });

    it("should respect user override", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "fileExplorer.copy", keys: "Ctrl+Shift+C" }],
      });
      // Old combo should NOT match
      const oldEvent = makeKeyEvent("c", { ctrl: true });
      expect(matchesKeybinding(oldEvent, "fileExplorer.copy")).toBe(false);
      // New combo should match
      const newEvent = makeKeyEvent("c", { ctrl: true, shift: true });
      expect(matchesKeybinding(newEvent, "fileExplorer.copy")).toBe(true);
    });

    it("should match arrow keys with normalized names", () => {
      const e = makeKeyEvent("ArrowDown", { ctrl: true, alt: true });
      expect(matchesKeybinding(e, "workspace.next")).toBe(true);
    });

    it("should return false for unknown action", () => {
      const e = makeKeyEvent("x", { ctrl: true });
      expect(matchesKeybinding(e, "unknown.action")).toBe(false);
    });

    it("should match Ctrl+, to settings.open", () => {
      const e = makeKeyEvent(",", { ctrl: true });
      expect(matchesKeybinding(e, "settings.open")).toBe(true);
    });
  });
});
