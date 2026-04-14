import { describe, it, expect } from "vitest";

import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  POST_FRAME_BUFFER_CURSOR,
  PRE_FRAME_BUFFER_CURSOR,
  RAW_TRACE_SLICE,
} from "./__fixtures__/codex-footer-frame";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  applyDec2026SetToShadowCursor,
  computeUseShadowCursor,
  getShadowSyncEligibility,
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

  it("uses shadow when sync-frame snapshot is fresh (TUI DEC 2026 path)", () => {
    expect(computeUseShadowCursor({ ...baseState, hasSyncFramePosition: true })).toBe(true);
  });

  it("falls back to live buffer cursor when no signal is asserting shadow", () => {
    expect(computeUseShadowCursor({ ...baseState, hasPromptBoundary: true })).toBe(false);
    expect(computeUseShadowCursor(baseState)).toBe(false);
  });

  it("does not treat composition as a shadow-cursor concern any more", () => {
    expect(
      computeUseShadowCursor({
        ...baseState,
        hasPromptBoundary: true,
      }),
    ).toBe(false);
  });
});

describe("getShadowSyncEligibility", () => {
  it("rejects sync while composition preview is active", () => {
    expect(
      getShadowSyncEligibility(baseState, {
        bufferAbsY: 0,
        compositionPreviewActive: true,
        syncOutputActive: false,
      }),
    ).toBe("composition-preview-active");
  });

  it("allows sync when shadow cursor has never been initialized (fresh terminal)", () => {
    // A freshly opened terminal (e.g. from empty view) has no OSC 133
    // prompt boundary and no DEC 2026 sync frame.  The shadow cursor is
    // still at (0,0) and must be seeded from the buffer cursor.
    expect(
      getShadowSyncEligibility(baseState, {
        bufferAbsY: 0,
        compositionPreviewActive: false,
        syncOutputActive: false,
      }),
    ).toBe("eligible");
  });

  it("rejects sync when prompt boundary exists but no input phase or sync frame", () => {
    // After OSC 133 A (prompt start) but before B (input start), shadow
    // cursor should not sync — the shell is still rendering the prompt.
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasPromptBoundary: true },
        {
          bufferAbsY: 0,
          compositionPreviewActive: false,
          syncOutputActive: false,
        },
      ),
    ).toBe("inactive");
  });

  it("rejects repaint, alt-buffer, and sync-output gates distinctly", () => {
    // hasPromptBoundary must be true alongside isInputPhase to bypass
    // the "never initialized" early-eligible path.
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasPromptBoundary: true, isInputPhase: true, isRepaintInProgress: true },
        { bufferAbsY: 0, compositionPreviewActive: false, syncOutputActive: false },
      ),
    ).toBe("repaint-in-progress");
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasPromptBoundary: true, isInputPhase: true, isAltBufferActive: true },
        { bufferAbsY: 0, compositionPreviewActive: false, syncOutputActive: false },
      ),
    ).toBe("alt-buffer");
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasPromptBoundary: true, isInputPhase: true },
        { bufferAbsY: 0, compositionPreviewActive: false, syncOutputActive: true },
      ),
    ).toBe("sync-output-active");
  });

  it("rejects sync-frame cursor updates when the live buffer row is not the saved row", () => {
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasSyncFramePosition: true, cursorAbsY: 12 },
        { bufferAbsY: 13, compositionPreviewActive: false, syncOutputActive: false },
      ),
    ).toBe("row-mismatch");
  });

  it("allows committed-input sync when the shadow owner is active", () => {
    expect(
      getShadowSyncEligibility(
        { ...baseState, hasPromptBoundary: true, isInputPhase: true },
        { bufferAbsY: 0, compositionPreviewActive: false, syncOutputActive: false },
      ),
    ).toBe("eligible");
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

describe("Codex footer-frame regression — DEC 2026 set/reset pre-frame snapshot", () => {
  // See `docs/terminal/cursor-jump-evidence/` for the captured trace
  // and prose write-up. Replays the exact pre/post cursor positions
  // observed when the user typed "Hello." into a Codex pane:
  //
  //   pre-frame buffer cursor = (X=2,  absY=106)  ← input prompt
  //   in-frame footer paint   ↓
  //   post-frame buffer cursor= (X=44, absY=108)  ← footer row
  //
  // Codex does NOT restore the cursor inside the same DEC 2026 wrap,
  // so reading the buffer at the `\e[?2026l` instant captures the
  // footer position. The fix is: snapshot the cursor at `\e[?2026h`,
  // restore it on `\e[?2026l`.

  it("DEC 2026 set saves pre-frame cursor; reset restores from save (not buffer)", () => {
    // Sanity-check the fixture is the live capture and not someone
    // editing the test in isolation. The cursor positions appear inside
    // the JSON-stringified payload, so they show up backslash-escaped
    // in the tracing log.
    expect(RAW_TRACE_SLICE).toContain('signals=["DEC2026:set"]');
    expect(RAW_TRACE_SLICE).toContain('signals=["DEC2026:reset"]');
    expect(RAW_TRACE_SLICE).toContain(`\\"cursorX\\":${POST_FRAME_BUFFER_CURSOR.x}`);
    expect(RAW_TRACE_SLICE).toContain(`\\"cursorAbsY\\":${POST_FRAME_BUFFER_CURSOR.absY}`);

    let state: ShadowCursorState = {
      ...baseState,
      cursorX: PRE_FRAME_BUFFER_CURSOR.x,
      cursorAbsY: PRE_FRAME_BUFFER_CURSOR.absY,
    };
    state = applyDec2026SetToShadowCursor(
      state,
      codex,
      PRE_FRAME_BUFFER_CURSOR.x,
      PRE_FRAME_BUFFER_CURSOR.absY,
    );
    // Frame body parses and moves the buffer cursor across rows 22..26;
    // no transitions fire here because syncOutputActive is true and the
    // existing scheduleShadowCursorSync gate already bails out.
    state = applyDec2026ResetToShadowCursor(
      state,
      codex,
      POST_FRAME_BUFFER_CURSOR.x,
      POST_FRAME_BUFFER_CURSOR.absY,
    );
    // The shadow cursor must come from the *saved* position, not the
    // buffer position at the reset instant.
    expect(state.cursorX).toBe(PRE_FRAME_BUFFER_CURSOR.x);
    expect(state.cursorAbsY).toBe(PRE_FRAME_BUFFER_CURSOR.absY);
    expect(state.hasSyncFramePosition).toBe(true);
  });

  it("falls back to buffer cursor when no DEC 2026 set fired (orphan reset)", () => {
    // Defensive: if for some reason the set was never observed (e.g.
    // it arrived in a chunk before the parser hooks were attached),
    // the existing behaviour — reading the live buffer — is the best
    // we can do. The test guards against the regression of the
    // *normal* case but documents the orphan-reset fallback.
    const state = applyDec2026ResetToShadowCursor(baseState, codex, 17, 9);
    expect(state.cursorX).toBe(17);
    expect(state.cursorAbsY).toBe(9);
    expect(state.hasSyncFramePosition).toBe(true);
  });

  it("DEC 2026 set is a no-op outside an overlay-caret activity", () => {
    const out = applyDec2026SetToShadowCursor(baseState, shell, 2, 106);
    expect(out).toBe(baseState);
  });

  it("activity-left-TUI clears any pending pre-frame snapshot too", () => {
    let state: ShadowCursorState = { ...baseState };
    state = applyDec2026SetToShadowCursor(state, codex, 2, 106);
    state = applyActivityLeftTuiToShadowCursor(state);
    // After leaving Codex the next stray `\e[?2026l` (e.g. from the
    // returning shell mistakenly emitting one) must NOT replay the
    // stale Codex input position over the shell's overlay.
    const reset = applyDec2026ResetToShadowCursor(state, codex, 99, 99);
    expect(reset.cursorX).toBe(99);
    expect(reset.cursorAbsY).toBe(99);
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
