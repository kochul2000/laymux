# Cursor-jump evidence: Codex footer frame

Captured 2026-04-13 from a live `LAYMUX_PTY_TRACE=1 LAYMUX_CURSOR_TRACE=1`
dev session while the user typed "Hello." into a Codex pane in workspace
"Default". Frontend activity badge correctly identified the pane as Codex.

PR #207 (`fix/codex-cursor-jump-after-shell`) made the OSC-133-stale-flag
fix land — `useShadowCursor` is now `true` in this trace, `hasPromptBoundary`
is `false`, `hasSyncFramePosition` is `true`, all as intended. **Yet the
overlay caret still jumps**, because Codex's DEC 2026 footer-update frame
ends with the buffer cursor parked on the footer row, not on the input row.

## What the bytes show

`codex-footer-frame.log` contains the 16-line slice of the interleaved
PTY+UI trace during a single ~50 ms window. Reading top-to-bottom:

1. `terminal-onData` — focus-in escape (`ESC [ I`) from the user
   activating the pane.
2. `shadow-sync` — pre-frame snapshot, cursor at `(X=2, absY=106)` =
   the input prompt.
3. `PTY chunk … signals=["DEC2026:set"] preview=\u{1b}[?2026h` — Codex
   begins a synchronized frame for the footer update.
4. `overlay-update` — last paint before the frame, cursor at
   `(X=2, Y=23)` = input prompt. **Correct.**
5. `PTY chunk … signals=["DEC2026:reset"] preview=…[22;2H[K…[24;39H[K…[25;2H[K…[26;45H[K…[?2026l`
   — the *single* chunk that contains the entire frame body. It moves
   the cursor across rows 22, 24, 25, 26, erasing each line, and ends
   with the cursor at row 26, column 45+ (the footer).
   **The frame does not restore the cursor to the input row before
   sending the DEC 2026 reset.**
6. Two `sync-output-visibility` toggles fire (`active=true` then `false`)
   — the rAF-driven sync-output watcher catches the `?2026h` then the
   `?2026l` from the same chunk. During `active=true` `shadow-sync-skip`
   correctly bails out.
7. `shadow-sync` — the DEC 2026 reset path in `applyDec2026ResetTo-
   ShadowCursor` snapshots `buffer.active.cursorX/Y`, which at this
   instant is `(X=44, absY=108)` = **the footer**. The shadow cursor
   has just been overwritten with the footer position.
8. (Out of frame:) the next overlay-update repaints the caret at
   `(X=44, Y=25)` — the visible jump — and shortly after a follow-up
   sync moves it back to `(X=2, absY=106)` once Codex eventually
   re-positions the cursor.

## Why the original PR is necessary but insufficient

PR #207 fixed the *gating* so the sync-frame snapshot path actually runs
inside Codex sessions started after a shell prompt. That was a real bug
(stale `hasPromptBoundary` blocked the snapshot entirely), confirmed by
this same trace mechanism. The remaining problem is independent: the
snapshot point — the moment of `\e[?2026l` — is not where Codex parks
its input cursor.

## Hypothesis for the second-stage fix

Codex's footer-update frame leaves the buffer cursor on the footer; the
intended input cursor is the position the cursor occupied **just before
the frame began**. So the snapshot we want is the pre-frame cursor, not
the post-frame cursor.

Concretely:
- On `\e[?2026h` (frame begin) record the current buffer cursor as the
  candidate input cursor (`frameSavedCursor`).
- On `\e[?2026l` (frame end) restore the shadow cursor to that saved
  snapshot rather than reading the buffer afresh.
- Clear the saved snapshot on alt-buffer entry / TUI-leave so it never
  outlives its session.

A targeted regression test that replays the exact pre/post cursor
positions from this trace lives at
`ui/src/lib/shadow-cursor-state.test.ts` — search for "Codex footer
frame" to find the case that reproduces this exact behaviour against
the pure state-transition helpers.
