import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock settings store before importing the module under test.
// isLxShortcut consults the keybinding registry, which reads user
// overrides from the settings store (#332/#333).
const mockGetState = vi.fn();
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}));

import { isLxShortcut } from "./lx-shortcuts";

function makeKeyEvent(
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...mods });
}

describe("isLxShortcut", () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ keybindings: [] });
  });

  // Ctrl+Alt+ArrowUp/Down: workspace navigation
  it("returns true for Ctrl+Alt+ArrowUp (previous workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowUp", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowDown (next workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowDown", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  // Ctrl+Alt+1~9: workspace switch
  it("returns true for Ctrl+Alt+1 through Ctrl+Alt+9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(isLxShortcut(makeKeyEvent(String(i), { ctrlKey: true, altKey: true }))).toBe(true);
    }
  });

  // Ctrl+Shift shortcuts
  it("returns false for Ctrl+Shift+W (moved to Ctrl+Alt)", () => {
    expect(isLxShortcut(makeKeyEvent("W", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("returns false for Ctrl+Shift+R (moved to Ctrl+Alt)", () => {
    expect(isLxShortcut(makeKeyEvent("R", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("returns true for Ctrl+Shift+U (jump to unread)", () => {
    expect(isLxShortcut(makeKeyEvent("U", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Shift+B (toggle sidebar)", () => {
    expect(isLxShortcut(makeKeyEvent("B", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Shift+I (toggle notification panel)", () => {
    expect(isLxShortcut(makeKeyEvent("I", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Shift+O (open file viewer)", () => {
    expect(isLxShortcut(makeKeyEvent("O", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isLxShortcut(makeKeyEvent("o", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+, (toggle settings)", () => {
    expect(isLxShortcut(makeKeyEvent(",", { ctrlKey: true }))).toBe(true);
  });

  // Alt+Arrow: pane navigation
  it("returns true for Alt+ArrowLeft", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowLeft", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowRight", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowRight", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowUp", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowUp", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowDown", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowDown", { altKey: true }))).toBe(true);
  });

  // Should NOT match — shell keys must pass through
  it("returns false for plain keys (no modifier)", () => {
    expect(isLxShortcut(makeKeyEvent("["))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("]"))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("b"))).toBe(false);
  });

  it("returns false for Ctrl+single-key (shell territory)", () => {
    expect(isLxShortcut(makeKeyEvent("c", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("v", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("b", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("i", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("[", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("]", { ctrlKey: true }))).toBe(false);
    expect(isLxShortcut(makeKeyEvent("1", { ctrlKey: true }))).toBe(false);
  });

  it("returns true for Ctrl+Alt+N (new workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("N", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+W (close workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("W", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+R (rename workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("R", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowLeft/Right (notification navigation)", () => {
    expect(isLxShortcut(makeKeyEvent("ArrowLeft", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isLxShortcut(makeKeyEvent("ArrowRight", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  // --- Case-insensitive Ctrl+Alt letter keys ---
  it("returns true for Ctrl+Alt+n (lowercase, new workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("n", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+w (lowercase, close workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("w", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+r (lowercase, rename workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("r", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Alt+d (lowercase, duplicate workspace)", () => {
    expect(isLxShortcut(makeKeyEvent("d", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  // issue #324: 1회성 CWD 전파 — 터미널 포커스 중에도 document 핸들러로 통과해야 한다
  it("returns true for Ctrl+Alt+P / Ctrl+Alt+p (propagate CWD once)", () => {
    expect(isLxShortcut(makeKeyEvent("P", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isLxShortcut(makeKeyEvent("p", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  // --- Case-insensitive Ctrl+Shift letter keys ---
  it("returns true for Ctrl+Shift+u (lowercase, jump to unread)", () => {
    expect(isLxShortcut(makeKeyEvent("u", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Shift+b (lowercase, toggle sidebar)", () => {
    expect(isLxShortcut(makeKeyEvent("b", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("returns true for Ctrl+Shift+i (lowercase, toggle notification panel)", () => {
    expect(isLxShortcut(makeKeyEvent("i", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  // --- Keybinding registry integration (#332/#333) ---
  describe("user overrides from keybinding registry", () => {
    it("passes through the new combo after rebinding (e.g. workspace.duplicate → Ctrl+Shift+P)", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "workspace.duplicate", keys: "Ctrl+Shift+P" }],
      });
      expect(isLxShortcut(makeKeyEvent("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(isLxShortcut(makeKeyEvent("p", { ctrlKey: true, shiftKey: true }))).toBe(true);
    });

    it("stops swallowing the old default combo after rebinding", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "workspace.duplicate", keys: "Ctrl+Shift+P" }],
      });
      // Ctrl+Alt+D is no longer bound to anything → must reach the shell
      expect(isLxShortcut(makeKeyEvent("D", { ctrlKey: true, altKey: true }))).toBe(false);
      expect(isLxShortcut(makeKeyEvent("d", { ctrlKey: true, altKey: true }))).toBe(false);
    });

    it("respects override for workspace navigation keys", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "workspace.next", keys: "Ctrl+Shift+Down" }],
      });
      expect(isLxShortcut(makeKeyEvent("ArrowDown", { ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(isLxShortcut(makeKeyEvent("ArrowDown", { ctrlKey: true, altKey: true }))).toBe(false);
    });

    it("never passes through Ctrl+single letter/digit even when rebound there (shell territory)", () => {
      mockGetState.mockReturnValue({
        keybindings: [
          { command: "workspace.new", keys: "Ctrl+N" },
          { command: "workspace.1", keys: "Ctrl+1" },
        ],
      });
      expect(isLxShortcut(makeKeyEvent("n", { ctrlKey: true }))).toBe(false);
      expect(isLxShortcut(makeKeyEvent("1", { ctrlKey: true }))).toBe(false);
    });

    it("does not pass through terminal-scoped bindings (terminal.copy/paste own their combos)", () => {
      mockGetState.mockReturnValue({
        keybindings: [
          // Conflict: terminal.copy and sidebar.toggle both on Ctrl+Shift+C —
          // the terminal-owned binding wins, so the key must NOT pass through.
          { command: "terminal.copy", keys: "Ctrl+Shift+C" },
          { command: "sidebar.toggle", keys: "Ctrl+Shift+C" },
        ],
      });
      expect(isLxShortcut(makeKeyEvent("C", { ctrlKey: true, shiftKey: true }))).toBe(false);
    });

    it("does not pass through combos bound only to terminal/memo scoped actions", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "terminal.zoomIn", keys: "Ctrl+Shift+=" }],
      });
      expect(isLxShortcut(makeKeyEvent("=", { ctrlKey: true, shiftKey: true }))).toBe(false);
    });

    it("respects pane.focus override while keeping Alt+Arrow wildcard semantics", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "pane.focus", keys: "Ctrl+Alt+Arrow" }],
      });
      expect(isLxShortcut(makeKeyEvent("ArrowLeft", { ctrlKey: true, altKey: true }))).toBe(true);
      // Old default Alt+Arrow no longer bound → not an IDE shortcut anymore
      expect(isLxShortcut(makeKeyEvent("ArrowLeft", { altKey: true }))).toBe(false);
    });

    it("respects pane.propagateCwdOnce override (document-level Pane action, #324)", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "pane.propagateCwdOnce", keys: "Ctrl+Shift+G" }],
      });
      expect(isLxShortcut(makeKeyEvent("G", { ctrlKey: true, shiftKey: true }))).toBe(true);
      // Old default Ctrl+Alt+P no longer bound → must reach the shell
      expect(isLxShortcut(makeKeyEvent("P", { ctrlKey: true, altKey: true }))).toBe(false);
    });
  });
});
