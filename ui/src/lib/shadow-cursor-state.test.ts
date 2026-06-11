import { describe, it, expect } from "vitest";

import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  PARK_BUFFER_CURSOR,
  POST_FRAME_BUFFER_CURSOR,
  PRE_FRAME_BUFFER_CURSOR,
  RAW_TRACE_SLICE,
} from "./__fixtures__/codex-footer-frame";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  applyDec2026SetToShadowCursor,
  applyDectcemHideToShadowCursor,
  applyDectcemShowToShadowCursor,
  applyParkSettleTimeoutToShadowCursor,
  computeUseShadowCursor,
  getShadowSyncEligibility,
  isDectcemShowPark,
  isOverlayCaretActivity,
  shouldFreezeOverlayForPark,
  type ShadowCursorState,
} from "./shadow-cursor-state";

const baseState: ShadowCursorState = {
  commandStartLine: 0,
  commandStartX: 0,
  cursorX: 0,
  cursorAbsY: 0,
  isCursorHidden: false,
  parkPending: false,
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

describe("DECTCEM 5th layer — Codex footer frame + cursor park replay", () => {
  // Full replay of the two chunks in `docs/terminal/cursor-jump-evidence/`:
  //
  //   chunk A (footer frame): ?2026h … ?25l erase×4 ?25h ?2026l
  //     — ends with the buffer cursor on the FOOTER row and the show
  //       fired while the sync frame was still open (untrusted tail).
  //   chunk B (park, ~15 ms later): ?25l [24;3H ?25h
  //     — hide–move–show outside any frame: the authoritative input
  //       cursor position.

  it("in-frame ?25h clears hidden but never moves the shadow position", () => {
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
    state = applyDectcemHideToShadowCursor(state, codex);
    expect(state.isCursorHidden).toBe(true);
    // ?25h fires while the DEC 2026 frame is still open, buffer cursor
    // parked on the footer — position must be ignored.
    state = applyDectcemShowToShadowCursor(
      state,
      codex,
      POST_FRAME_BUFFER_CURSOR.x,
      POST_FRAME_BUFFER_CURSOR.absY,
      /* syncOutputActive */ true,
    );
    expect(state.isCursorHidden).toBe(false);
    expect(state.cursorX).toBe(PRE_FRAME_BUFFER_CURSOR.x);
    expect(state.cursorAbsY).toBe(PRE_FRAME_BUFFER_CURSOR.absY);
  });

  it("frame flush sets parkPending; the out-of-frame park clears it and wins", () => {
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
    state = applyDec2026ResetToShadowCursor(
      state,
      codex,
      POST_FRAME_BUFFER_CURSOR.x,
      POST_FRAME_BUFFER_CURSOR.absY,
    );
    expect(state.parkPending).toBe(true);
    // Chunk B: hide, CUP to the input row, show — outside any frame.
    state = applyDectcemHideToShadowCursor(state, codex);
    state = applyDectcemShowToShadowCursor(
      state,
      codex,
      PARK_BUFFER_CURSOR.x,
      PARK_BUFFER_CURSOR.absY,
      /* syncOutputActive */ false,
    );
    expect(state.parkPending).toBe(false);
    expect(state.isCursorHidden).toBe(false);
    expect(state.cursorX).toBe(PARK_BUFFER_CURSOR.x);
    expect(state.cursorAbsY).toBe(PARK_BUFFER_CURSOR.absY);
    expect(state.hasSyncFramePosition).toBe(true);
    expect(computeUseShadowCursor(state)).toBe(true);
  });

  it("consecutive frames without a park between them: the park still rescues", () => {
    // Regression for the worst pre-frame-snapshot failure: frame N ends
    // with the buffer cursor on the footer, frame N+1 begins before any
    // park — its pre-frame snapshot captures the FOOTER, and the old
    // row-equality sync gate could never recover (park row ≠ shadow
    // row → "row-mismatch" skip, stuck on the footer indefinitely).
    let state: ShadowCursorState = { ...baseState };
    // Frame N+1 opens with the cursor still parked on the footer.
    state = applyDec2026SetToShadowCursor(
      state,
      codex,
      POST_FRAME_BUFFER_CURSOR.x,
      POST_FRAME_BUFFER_CURSOR.absY,
    );
    state = applyDec2026ResetToShadowCursor(
      state,
      codex,
      POST_FRAME_BUFFER_CURSOR.x,
      POST_FRAME_BUFFER_CURSOR.absY,
    );
    // Fallback estimate is the footer — but parkPending keeps the
    // overlay frozen, so nothing is painted there.
    expect(state.cursorAbsY).toBe(POST_FRAME_BUFFER_CURSOR.absY);
    expect(state.parkPending).toBe(true);
    // The park overwrites unconditionally — no row-equality gate.
    state = applyDectcemShowToShadowCursor(
      state,
      codex,
      PARK_BUFFER_CURSOR.x,
      PARK_BUFFER_CURSOR.absY,
      false,
    );
    expect(state.cursorX).toBe(PARK_BUFFER_CURSOR.x);
    expect(state.cursorAbsY).toBe(PARK_BUFFER_CURSOR.absY);
    expect(state.parkPending).toBe(false);
  });

  it("an out-of-frame park clears stale OSC 133 shell flags (Codex-after-shell)", () => {
    const stale: ShadowCursorState = {
      ...baseState,
      hasPromptBoundary: true,
      isInputPhase: true,
      isRepaintInProgress: true,
    };
    const out = applyDectcemShowToShadowCursor(stale, codex, 5, 40, false);
    expect(out.hasPromptBoundary).toBe(false);
    expect(out.isInputPhase).toBe(false);
    expect(out.isRepaintInProgress).toBe(false);
    expect(out.hasSyncFramePosition).toBe(true);
  });

  it("settle timeout releases the freeze and keeps the fallback position", () => {
    let state: ShadowCursorState = { ...baseState };
    state = applyDec2026ResetToShadowCursor(state, codex, 7, 50);
    expect(state.parkPending).toBe(true);
    state = applyParkSettleTimeoutToShadowCursor(state);
    expect(state.parkPending).toBe(false);
    // Position untouched: at-reset fallback remains the best estimate.
    expect(state.cursorX).toBe(7);
    expect(state.cursorAbsY).toBe(50);
  });

  it("settle timeout is a no-op when no park is pending", () => {
    expect(applyParkSettleTimeoutToShadowCursor(baseState)).toBe(baseState);
  });

  it("alt-buffer ?25h is never a park (review regression: editor inside Codex)", () => {
    // Review regression (PR #313): a full-screen app on the alternate
    // buffer (editor/pager launched while the activity is still Codex)
    // sends `?25h` out-of-frame, then exits via `?1049l`. Storing its
    // alt-buffer coordinates as an authoritative park would leave
    // `hasSyncFramePosition` pointing at garbage back on the normal
    // buffer, and the row-mismatch sync gate would pin the overlay
    // there until the next park.
    // Mirrors the TerminalView `?1049h` branch: alt entry clears the
    // sync-frame position and pending park state.
    let state: ShadowCursorState = {
      ...baseState,
      cursorX: 2,
      cursorAbsY: 106,
      isAltBufferActive: true,
      hasSyncFramePosition: false,
    };
    state = applyDectcemHideToShadowCursor(state, codex);
    // Alt app shows the cursor at its own coordinates, out-of-frame.
    state = applyDectcemShowToShadowCursor(state, codex, 77, 9999, false);
    // Visibility cleared, but nothing parked: position and sync-frame
    // ownership untouched.
    expect(state.isCursorHidden).toBe(false);
    expect(state.cursorX).toBe(2);
    expect(state.cursorAbsY).toBe(106);
    expect(state.hasSyncFramePosition).toBe(false);
    // Back on the normal buffer the shadow is uninitialized, so the
    // regular sync path may reseed from the buffer cursor — the gate
    // that previously caused the pin must not engage.
    state = { ...state, isAltBufferActive: false };
    expect(
      getShadowSyncEligibility(state, {
        bufferAbsY: 120,
        compositionPreviewActive: false,
        syncOutputActive: false,
      }),
    ).toBe("eligible");
  });

  it("DECTCEM transitions are no-ops outside an overlay-caret activity", () => {
    for (const activity of [shell, claude, undefined]) {
      expect(applyDectcemHideToShadowCursor(baseState, activity)).toBe(baseState);
      expect(applyDectcemShowToShadowCursor(baseState, activity, 9, 9, false)).toBe(baseState);
    }
  });

  it("frame ending hidden (?25l … ?2026l with no show): hide wins over the park freeze", () => {
    // Review regression (PR #313): when a DEC 2026 frame hides the
    // cursor and ends without a matching `?25h`, both `parkPending`
    // and `isCursorHidden` are true. The park freeze must NOT swallow
    // the repaint — the previously *visible* overlay would otherwise
    // stay on screen for up to the settle window, contradicting the
    // app's explicit hide. Sustained hide must reach paint immediately.
    let state: ShadowCursorState = { ...baseState };
    state = applyDec2026SetToShadowCursor(state, codex, 2, 106);
    state = applyDectcemHideToShadowCursor(state, codex);
    // Frame flushes with the cursor still hidden — no `?25h` arrived.
    state = applyDec2026ResetToShadowCursor(state, codex, 44, 108);
    expect(state.parkPending).toBe(true);
    expect(state.isCursorHidden).toBe(true);
    // The freeze must yield so the hidden state can hide the overlay.
    expect(shouldFreezeOverlayForPark(state, false)).toBe(false);
    // Once the (late) park shows the cursor again, freeze stays off
    // because the park itself cleared parkPending.
    state = applyDectcemShowToShadowCursor(state, codex, 2, 106, false);
    expect(shouldFreezeOverlayForPark(state, false)).toBe(false);
  });

  it("isDectcemShowPark truth table — single source for the park decision", () => {
    // Park only outside a sync frame on the normal buffer. This same
    // predicate gates both the state transition and TerminalView's
    // park side effects (settle-timer clear, trace), so they cannot
    // drift apart.
    expect(isDectcemShowPark({ isAltBufferActive: false }, false)).toBe(true);
    expect(isDectcemShowPark({ isAltBufferActive: false }, true)).toBe(false);
    expect(isDectcemShowPark({ isAltBufferActive: true }, false)).toBe(false);
    expect(isDectcemShowPark({ isAltBufferActive: true }, true)).toBe(false);
  });

  it("shouldFreezeOverlayForPark truth table", () => {
    // Freezes only in the plain park-pending case.
    expect(shouldFreezeOverlayForPark({ parkPending: true, isCursorHidden: false }, false)).toBe(
      true,
    );
    // No park pending → nothing to freeze.
    expect(shouldFreezeOverlayForPark({ parkPending: false, isCursorHidden: false }, false)).toBe(
      false,
    );
    // Sustained DECTCEM hide takes precedence over the freeze.
    expect(shouldFreezeOverlayForPark({ parkPending: true, isCursorHidden: true }, false)).toBe(
      false,
    );
    // Composition preview takes precedence over the freeze.
    expect(shouldFreezeOverlayForPark({ parkPending: true, isCursorHidden: false }, true)).toBe(
      false,
    );
  });

  it("leaving the TUI clears parkPending and hidden state", () => {
    const inFlight: ShadowCursorState = {
      ...baseState,
      parkPending: true,
      isCursorHidden: true,
      hasSyncFramePosition: true,
    };
    const out = applyActivityLeftTuiToShadowCursor(inFlight);
    expect(out.parkPending).toBe(false);
    expect(out.isCursorHidden).toBe(false);
    expect(out.hasSyncFramePosition).toBe(false);
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
