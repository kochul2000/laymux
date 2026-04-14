/**
 * Test fixture: live cursor-jump trace captured 2026-04-13 from a Codex
 * pane in `ws-default` while the user typed "Hello.". Distilled from
 * `LAYMUX_PTY_TRACE=1 LAYMUX_CURSOR_TRACE=1` interleaved logs.
 *
 * Files (same directory):
 *   docs/terminal/cursor-jump-evidence/codex-footer-frame.log —
 *     the 16-line raw slice as it appeared in the live `tracing` stream
 *     (PTY chunks + UI cursor trace events). Single source of truth;
 *     this fixture reads that file via a relative path.
 *
 * Companion prose write-up:
 *   docs/terminal/cursor-jump-evidence/README.md
 *
 * The fixture is intentionally minimal: the assertions in
 * `shadow-cursor-state.test.ts` only need the input/output cursor
 * positions, not a full PTY-byte replay. Extracting them here keeps
 * the test pinned to the exact numbers from the field capture so a
 * future regression "still passes the unit test" cannot drift away
 * from the real bug.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** Raw 16-line trace slice — kept for grep-ability and forensic reads. */
export const RAW_TRACE_SLICE: string = readFileSync(
  join(__dirname, "../../../../docs/terminal/cursor-jump-evidence/codex-footer-frame.log"),
  "utf-8",
).replace(/\r\n/g, "\n");

/**
 * Cursor state at the moment the DEC 2026 *set* sequence (`\e[?2026h`)
 * fired — i.e. the cursor as Codex left it after the user's keystroke
 * was echoed onto the input prompt. This is what the overlay should
 * display for the duration of the upcoming footer frame.
 */
export const PRE_FRAME_BUFFER_CURSOR = { x: 2, absY: 106 } as const;

/**
 * Cursor state at the moment the DEC 2026 *reset* sequence (`\e[?2026l`)
 * fired — i.e. where Codex parked the buffer cursor at the end of the
 * footer paint. This is the WRONG position for the overlay; reading the
 * buffer at this instant is what produced the visible jump.
 */
export const POST_FRAME_BUFFER_CURSOR = { x: 44, absY: 108 } as const;

/**
 * The cursor row (zero-indexed display row inside the viewport) the
 * overlay was *observed* to jump to during the bug — captured here so
 * any regression that re-introduces the jump produces the same number
 * the user originally reported, not just "some wrong row".
 */
export const OBSERVED_JUMP_DISPLAY_ROW = 25;
