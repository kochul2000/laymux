import { describe, it, expect } from "vitest";

import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  computeUseShadowCursor,
  isOverlayCaretActivity,
  type ShadowCursorState,
} from "./shadow-cursor-state";

const baseState: ShadowCursorState = {
  commandStartLine: 0,
  commandStartX: 0,
  cursorX: 0,
  cursorAbsY: 0,
  hasPromptBoundary: false,
  hasSyncFramePosition: false,
  isComposing: false,
  isInputPhase: false,
  isRepaintInProgress: false,
  isAltBufferActive: false,
};

const codex: TerminalActivityInfo = { type: "interactiveApp", name: "Codex" };
const claude: TerminalActivityInfo = { type: "interactiveApp", name: "Claude" };
const shell: TerminalActivityInfo = { type: "shell" };

describe("isOverlayCaretActivity", () => {
  it("matches only Codex (intentional — see shadow-cursor-state.ts docblock)", () => {
    expect(isOverlayCaretActivity(codex)).toBe(true);
    expect(isOverlayCaretActivity(claude)).toBe(false);
    expect(isOverlayCaretActivity(shell)).toBe(false);
    expect(isOverlayCaretActivity(undefined)).toBe(false);
  });
});

describe("computeUseShadowCursor", () => {
  it("uses shadow when OSC 133 path is active (prompt boundary + input phase)", () => {
    expect(
      computeUseShadowCursor({ ...baseState, hasPromptBoundary: true, isInputPhase: true }),
    ).toBe(true);
  });

  it("uses shadow during IME composition even without input phase", () => {
    expect(
      computeUseShadowCursor({ ...baseState, hasPromptBoundary: true, isComposing: true }),
    ).toBe(true);
  });

  it("uses shadow when sync-frame snapshot is fresh (TUI DEC 2026 path)", () => {
    expect(computeUseShadowCursor({ ...baseState, hasSyncFramePosition: true })).toBe(true);
  });

  it("falls back to live buffer cursor when no signal is asserting shadow", () => {
    expect(computeUseShadowCursor({ ...baseState, hasPromptBoundary: true })).toBe(false);
    expect(computeUseShadowCursor(baseState)).toBe(false);
  });
});

describe("applyDec2026ResetToShadowCursor — the cursor-jump regression fix", () => {
  // Regression being fixed: a prior shell session set `hasPromptBoundary=true`,
  // then the user launched Codex (pure TUI, no OSC 133). The DEC 2026 reset
  // path guarded on `!hasPromptBoundary`, so it was skipped for Codex-after-
  // shell — and `computeUseShadowCursor` then fell back to the live buffer
  // cursor, which jumped to the footer on every Codex repaint.

  it("snapshots the buffer cursor on DEC 2026 reset inside a Codex frame", () => {
    const out = applyDec2026ResetToShadowCursor(baseState, codex, 13, 7);
    expect(out.hasSyncFramePosition).toBe(true);
    expect(out.cursorX).toBe(13);
    expect(out.cursorAbsY).toBe(7);
  });

  it("clears stale OSC 133 flags carried over from a prior shell session", () => {
    const stale: ShadowCursorState = {
      ...baseState,
      hasPromptBoundary: true,
      isInputPhase: true,
      isRepaintInProgress: true,
      commandStartX: 4,
      commandStartLine: 9,
    };
    const out = applyDec2026ResetToShadowCursor(stale, codex, 13, 7);
    // Core assertion: the presence of a stale prompt boundary does NOT
    // block the sync-frame snapshot any more.
    expect(out.hasSyncFramePosition).toBe(true);
    expect(out.hasPromptBoundary).toBe(false);
    expect(out.isInputPhase).toBe(false);
    expect(out.isRepaintInProgress).toBe(false);
    // commandStart* are shell-session data; we leave them alone so the
    // returning shell's OSC 133 B can overwrite them cleanly.
    expect(out.commandStartX).toBe(4);
    expect(out.commandStartLine).toBe(9);
  });

  it("no-ops for non-overlay activities (shell, Claude, undefined)", () => {
    for (const activity of [shell, claude, undefined]) {
      expect(applyDec2026ResetToShadowCursor(baseState, activity, 13, 7)).toBe(baseState);
    }
  });

  it("after the reset, computeUseShadowCursor returns true for Codex even with no OSC 133", () => {
    // End-to-end of the fix: stale hasPromptBoundary used to leave this `false`.
    const shellHistory: ShadowCursorState = { ...baseState, hasPromptBoundary: true };
    const afterReset = applyDec2026ResetToShadowCursor(shellHistory, codex, 13, 7);
    expect(computeUseShadowCursor(afterReset)).toBe(true);
  });
});

describe("applyActivityLeftTuiToShadowCursor", () => {
  it("clears the per-frame sync snapshot so OSC 133 can drive the returning shell", () => {
    const stuck: ShadowCursorState = {
      ...baseState,
      hasSyncFramePosition: true,
      cursorX: 42,
      cursorAbsY: 9,
    };
    const out = applyActivityLeftTuiToShadowCursor(stuck);
    expect(out.hasSyncFramePosition).toBe(false);
    // Coordinates are harmless leftovers — the next OSC 133 B will
    // overwrite them synchronously, and computeUseShadowCursor now
    // returns false until then.
    expect(computeUseShadowCursor(out)).toBe(false);
  });
});
