import { describe, it, expect } from "vitest";
import { isLxShortcut } from "./lx-shortcuts";

function makeKeyEvent(
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...mods });
}

describe("isLxShortcut", () => {
  // Ctrl+Alt+ArrowUp/Down: workspace navigation
  it("returns true for Ctrl+Alt+ArrowUp (previous workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("ArrowUp", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowDown (next workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("ArrowDown", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // Ctrl+Alt+1~9: workspace switch
  it("returns true for Ctrl+Alt+1 through Ctrl+Alt+9", () => {
    for (let i = 1; i <= 9; i++) {
      expect(
        isLxShortcut(makeKeyEvent(String(i), { ctrlKey: true, altKey: true })),
      ).toBe(true);
    }
  });

  // Ctrl+Shift shortcuts
  it("returns false for Ctrl+Shift+W (moved to Ctrl+Alt)", () => {
    expect(
      isLxShortcut(makeKeyEvent("W", { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("returns false for Ctrl+Shift+R (moved to Ctrl+Alt)", () => {
    expect(
      isLxShortcut(makeKeyEvent("R", { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("returns true for Ctrl+Shift+U (jump to unread)", () => {
    expect(
      isLxShortcut(makeKeyEvent("U", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+B (toggle sidebar)", () => {
    expect(
      isLxShortcut(makeKeyEvent("B", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+I (toggle notification panel)", () => {
    expect(
      isLxShortcut(makeKeyEvent("I", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
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
    expect(
      isLxShortcut(makeKeyEvent("N", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+W (close workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("W", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+R (rename workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("R", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+ArrowLeft/Right (notification navigation)", () => {
    expect(
      isLxShortcut(makeKeyEvent("ArrowLeft", { ctrlKey: true, altKey: true })),
    ).toBe(true);
    expect(
      isLxShortcut(makeKeyEvent("ArrowRight", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // --- Case-insensitive Ctrl+Alt letter keys ---
  it("returns true for Ctrl+Alt+n (lowercase, new workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("n", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+w (lowercase, close workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("w", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+r (lowercase, rename workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("r", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Alt+d (lowercase, duplicate workspace)", () => {
    expect(
      isLxShortcut(makeKeyEvent("d", { ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  // --- Case-insensitive Ctrl+Shift letter keys ---
  it("returns true for Ctrl+Shift+u (lowercase, jump to unread)", () => {
    expect(
      isLxShortcut(makeKeyEvent("u", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+b (lowercase, toggle sidebar)", () => {
    expect(
      isLxShortcut(makeKeyEvent("b", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("returns true for Ctrl+Shift+i (lowercase, toggle notification panel)", () => {
    expect(
      isLxShortcut(makeKeyEvent("i", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });
});
