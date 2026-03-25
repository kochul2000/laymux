import { describe, it, expect } from "vitest";
import { isIdeShortcut } from "./ide-shortcuts";

function makeKeyEvent(
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...mods });
}

describe("isIdeShortcut", () => {
  // Ctrl+Alt+ArrowUp/Down: workspace navigation
  it("returns true for Ctrl+Alt+ArrowUp (previous workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("ArrowUp", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowDown (next workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("ArrowDown", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // Ctrl+Alt+1~9: workspace switch
  it("returns true for Ctrl+Alt+1 through Ctrl+Alt+9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(
        isIdeShortcut(makeKeyEvent(String(i), { ctrlKey: true, altKey: true })),
      ).toBe(true);
    }
  });

  // Ctrl+Shift shortcuts
  it("returns false for Ctrl+Shift+W (moved to Ctrl+Alt)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("W", { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("returns false for Ctrl+Shift+R (moved to Ctrl+Alt)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("R", { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("returns true for Ctrl+Shift+U (jump to unread)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("U", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+B (toggle sidebar)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("B", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+I (toggle notification panel)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("I", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+, (toggle settings)", () => {
    expect(isIdeShortcut(makeKeyEvent(",", { ctrlKey: true }))).toBe(true);
  });

  // Alt+Arrow: pane navigation
  it("returns true for Alt+ArrowLeft", () => {
    expect(isIdeShortcut(makeKeyEvent("ArrowLeft", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowRight", () => {
    expect(isIdeShortcut(makeKeyEvent("ArrowRight", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowUp", () => {
    expect(isIdeShortcut(makeKeyEvent("ArrowUp", { altKey: true }))).toBe(true);
  });

  it("returns true for Alt+ArrowDown", () => {
    expect(isIdeShortcut(makeKeyEvent("ArrowDown", { altKey: true }))).toBe(true);
  });

  // Should NOT match — shell keys must pass through
  it("returns false for plain keys (no modifier)", () => {
    expect(isIdeShortcut(makeKeyEvent("["))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("]"))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("b"))).toBe(false);
  });

  it("returns false for Ctrl+single-key (shell territory)", () => {
    expect(isIdeShortcut(makeKeyEvent("c", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("v", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("b", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("i", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("[", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("]", { ctrlKey: true }))).toBe(false);
    expect(isIdeShortcut(makeKeyEvent("1", { ctrlKey: true }))).toBe(false);
  });

  it("returns true for Ctrl+Alt+N (new workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("N", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+W (close workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("W", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+R (rename workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("R", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowLeft/Right (notification navigation)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("ArrowLeft", { ctrlKey: true, altKey: true })),
    ).toBe(true);
    expect(
      isIdeShortcut(makeKeyEvent("ArrowRight", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // --- Case-insensitive Ctrl+Alt letter keys ---
  it("returns true for Ctrl+Alt+n (lowercase, new workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("n", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+w (lowercase, close workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("w", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+r (lowercase, rename workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("r", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+d (lowercase, duplicate workspace)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("d", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // --- Case-insensitive Ctrl+Shift letter keys ---
  it("returns true for Ctrl+Shift+u (lowercase, jump to unread)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("u", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+b (lowercase, toggle sidebar)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("b", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+i (lowercase, toggle notification panel)", () => {
    expect(
      isIdeShortcut(makeKeyEvent("i", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });
});
