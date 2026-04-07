/**
 * Test fixture: Claude Code OAuth URL from a 75-column terminal.
 *
 * Files (same directory):
 *   right-pane-output.txt — raw PTY output (ANSI escape sequences)
 *   right-pane-human.txt  — what the user sees (lines padded to terminal width)
 *   right-pane-wrong.txt  — broken result (raw selection with newlines stripped)
 *   right-pane-right.txt  — expected clean URL
 */
import { readFileSync } from "fs";
import { join } from "path";

const dir = __dirname;

function read(name: string): string {
  return readFileSync(join(dir, name), "utf-8").replace(/\r\n/g, "\n");
}

/** Raw PTY output with ANSI escape sequences (cursor positioning, SGR colors, etc). */
export const RAW_PTY_OUTPUT: string = read("right-pane-output.txt");

/** Human-visible terminal output (75-col lines). */
const humanText = read("right-pane-human.txt");

/**
 * Raw xterm.js getSelection() equivalent — URL lines (3–9 of human.txt),
 * each padded to terminal width with trailing spaces, joined by "\n".
 */
export const RAW_XTERM_SELECTION: string = humanText
  .split("\n")
  .slice(2, 9) // lines 3–9 (0-indexed 2–8)
  .join("\n");

/**
 * Broken result: raw selection with newlines removed.
 * Trailing-space + leading-indent creates 4-space gaps between URL fragments.
 */
export const WRONG_RESULT: string = read("right-pane-wrong.txt").trimEnd();

/**
 * Expected clean URL (no leading indent, no internal spaces).
 */
export const CLEAN_URL: string = read("right-pane-right.txt").trim();
