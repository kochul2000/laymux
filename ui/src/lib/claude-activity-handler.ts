import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState, StatusResult } from "./activity-handler";

/**
 * Star-based working spinner prefixes emitted by Claude Code while a task is
 * in progress. Mirrors `WORKING_STAR_SPINNERS` in
 * `src-tauri/src/claude_activity.rs` — keep both lists in sync.
 */
const WORKING_STAR_SPINNERS = ["\u2736", "\u273B", "\u273D", "\u2722"];

/**
 * Idle prefix (✳ U+2733). Claude Code switches to this exact character when
 * it is waiting for user input.
 */
const CLAUDE_IDLE_PREFIX = "\u2733"; // ✳

/** Inclusive Braille Patterns block used by Claude's spinner animation. */
const BRAILLE_RANGE_START = 0x2800;
const BRAILLE_RANGE_END = 0x28ff;

const DEFAULT_STATUS_MESSAGE_DELIMITER = " \u00b7 ";

function isBraille(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= BRAILLE_RANGE_START && code <= BRAILLE_RANGE_END;
}

/**
 * Returns true when `title` starts with a Claude working spinner (star or
 * Braille). Excludes the idle prefix (✳) — that means "task finished, waiting
 * for input", not "working".
 *
 * Keep in sync with `is_claude_working_title()` in
 * `src-tauri/src/claude_activity.rs`. Both title sources (Rust-detected
 * `terminal-title-changed` events and direct OSC 0/2) flow through this helper
 * so the status icon always reflects live spinner activity.
 */
function isClaudeWorkingTitle(title: string | undefined): boolean {
  if (!title) return false;
  const first = title.charAt(0);
  return WORKING_STAR_SPINNERS.includes(first) || isBraille(first);
}

function extractTitleMessage(title: string | undefined): string | undefined {
  if (!title) return undefined;
  if (!isClaudeWorkingTitle(title)) return undefined;

  const stripped = title.slice(1).trim();
  if (!stripped || stripped === "Claude Code") return undefined;
  return stripped;
}

export class ClaudeActivityHandler extends ShellActivityHandler {
  shouldPreserveActivityOnExitCode(): boolean {
    return true;
  }

  /**
   * Keep the `interactiveApp: Claude` activity even when the incoming
   * `terminal-title-changed` event carries `interactiveApp: null`.
   *
   * Claude Code emits OSC 0/2 title sequences that the Rust side cannot
   * always resolve back to "Claude":
   *   - Path-like titles (e.g. `~/project`, `C:\\Users\\...`) — Rust's
   *     `detect_interactive_app_from_title` rejects anything containing
   *     `/` or `\` outright.
   *   - Braille-only spinner titles emitted before the buffer has logged
   *     a `"Claude Code"` substring that `any_terminal_title_contains`
   *     can match and insert into `known_claude_terminals`.
   *   - PowerShell's `prompt` function rewriting the window title on
   *     every keystroke while Claude is running.
   *
   * Without this override, `useSyncEvents` would overwrite the live
   * Claude activity with `{ type: "shell" }`, so the top-left workspace
   * icon flips back to "shell" even though Claude Code is still alive.
   * Mirrors `CodexActivityHandler.shouldPreserveActivityOnTitleReset`.
   * See issue #234.
   */
  shouldPreserveActivityOnTitleReset(): boolean {
    return true;
  }

  computeStatus(raw: RawTerminalState): StatusResult {
    if (raw.outputActive) return { icon: "⏳", color: "var(--yellow)" };

    // Working spinner title (star or Braille) means Claude is actively
    // processing — e.g. the local-agent / sub-agent path where the title
    // is "⠂ Task description" but no OSC 133;C burst fires and outputActive
    // stays false. Without this branch, the status would fall through to
    // ShellActivityHandler which inherits the stale `exitCode=0` from the
    // previous synthetic completion and display ✓ even though work is in
    // progress. See issue #225.
    if (isClaudeWorkingTitle(raw.title)) {
      return { icon: "⏳", color: "var(--yellow)" };
    }

    // Claude keeps its process alive after finishing a task and switches its
    // title to the idle marker (✳ U+2733). A synthetic exitCode=0 is emitted
    // on task completion, but the claude process itself never exits, so on a
    // fresh task the workspace icon must still reflect the idle/completed
    // state instead of falling through to the gray dash. Treat idle title as
    // success.
    if (raw.title?.startsWith(CLAUDE_IDLE_PREFIX)) {
      return { icon: "✓", color: "var(--green)" };
    }
    return super.computeStatus(raw);
  }

  computeStatusMessage(raw: RawTerminalState): string | undefined {
    const bullet = raw.activityMessage || undefined;
    const titleMsg = extractTitleMessage(raw.title);
    const mode = raw.statusMessageMode ?? "bullet-title";
    const delimiter = raw.statusMessageDelimiter ?? DEFAULT_STATUS_MESSAGE_DELIMITER;

    switch (mode) {
      case "bullet":
        return bullet;
      case "title":
        return titleMsg;
      case "bullet-title":
        if (bullet && titleMsg) return `${bullet}${delimiter}${titleMsg}`;
        return bullet || titleMsg || undefined;
      case "title-bullet":
        if (bullet && titleMsg) return `${titleMsg}${delimiter}${bullet}`;
        return titleMsg || bullet || undefined;
      default:
        return bullet || titleMsg || undefined;
    }
  }
}
