import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  detectRegisteredActivityFromCommand,
  detectRegisteredActivityFromTitle,
} from "./activity-handler";
import { CLAUDE_INPUT_PENDING_MARKER, CODEX_INPUT_PENDING_MARKER } from "./activity-markers";

// Re-export so existing call sites that already import these markers from
// `activity-detection` keep working. The canonical source is `activity-markers`
// to keep the import graph acyclic \u2014 see the doc comment there.
export { CLAUDE_INPUT_PENDING_MARKER, CODEX_INPUT_PENDING_MARKER };
const MIDDLE_DOT = "\u00b7";
const ASSISTANT_BULLET = "\u2022";

/**
 * Matches an arrow-prefixed numbered option such as `\u276f 1. Yes` /
 * `\u276f 2. No, \u2026`. The option text is required to be non-empty so the
 * regular Claude input prompt `\u2570\u2500\u276f ` (no number follows) is excluded.
 */
const CLAUDE_ARROWED_OPTION = /\u276f\s*\d+\.\s+\S/;

/**
 * Matches a numbered option line such as `1. Yes` / `  2. Yes, and don't ask
 * again`. The leading anchor accepts start-of-line, whitespace, or the
 * vertical box edge Claude uses to frame the modal, so options indented inside
 * `\u2502` borders still match.
 */
const CLAUDE_NUMBERED_OPTION = /(?:^|[\s\u2502|])\d+\.\s+\S/gm;
const CLAUDE_NORMAL_INPUT_PROMPT = /\u2570\u2500\u276f(?:\s|$)/;
const CLAUDE_SELECTION_ARROW = "\u276f";

/** U+203B REFERENCE MARK \u2014 the glyph Claude Code prefixes every recap line with. */
const CLAUDE_RECAP_REFERENCE_MARK = "\u203b";

/**
 * Matches a Claude Code recap block in stripAnsi-normalised text.
 *
 * Claude renders the recap as `\u203b recap: <one-line summary> (disable recaps
 * in /config)`. The summary is wrapped across several alt-screen rows via CUP
 * cursor escapes and indented with CUF/space runs, so this regex is meant to
 * run AFTER `stripAnsi` has converted CUP\u2192`\n` and CUF(N)\u2192N spaces \u2014 the
 * wrapped fragments then arrive as ordinary whitespace-separated text that the
 * `[\s\S]*?` body re-joins. The summary terminates at whichever comes first:
 * the `(disable recaps in /config)` hint (present in most builds), a
 * box-drawing rule (`\u2500{3,}`) Claude draws beneath the recap, or end-of-input.
 * The `g` flag lets the caller pick the LAST match so a buffer that has
 * accumulated several recaps surfaces only the freshest one.
 */
const CLAUDE_RECAP_PATTERN = new RegExp(
  `${CLAUDE_RECAP_REFERENCE_MARK}\\s*recap:\\s*([\\s\\S]*?)(?:\\(disable recaps in /config\\)|\u2500{3,}|$)`,
  "g",
);

/**
 * Size of the rolling window used to scan for a Claude permission modal.
 * Claude renders the modal in alt-screen mode and redraws the entire frame
 * every spinner tick (~150 ms). One frame is dominated by ANSI cursor
 * positioning + colour escapes \u2014 a real WSL session that hit this bug had
 * a 4 KB modal frame inside 29 KB of total ring-buffer output where the
 * latest 1 KB held only the spinner footer. 16 KB comfortably covers
 * several frames so the modal stays visible to the detector until the
 * user answers it.
 */
const CLAUDE_DETECTION_WINDOW = 16384;

/**
 * Strips CSI / SGR escape sequences (e.g. `\x1b[38;5;246m`) and OSC sequences
 * (e.g. `\x1b]133;A\x07`) so a regex can run against the printable text only.
 *
 * Live Claude Code modal output is more than just colour-coded text \u2014 it
 * paints the modal frame using cursor-control escapes:
 *
 *   `\u276f \x1b[38;5;246m1. \x1b[38;5;153m\ucf54\ub4dc \uc791\uc131/\uc218\uc815`        \u2190 first option, literal space after "1."
 *   `\x1b[17;3H2.\x1b[m\x1b[1C\ucf54\ub4dc\x1b[1C\ud0d0\uc0c9/\ubd84\uc11d`           \u2190 second option, CUF for spacing + CUP for row
 *   `\x1b[18;6H\ucf54\ub4dc\ubca0\uc774\uc2a4\x1b[1C\uad6c\uc870\x1b[1C\ud30c\uc545`              \u2190 description on next row
 *   `\x1b[19;3H3.\x1b[m\x1b[1C\ubb38\uc11c/\uc124\uba85`                     \u2190 third option
 *
 * Two layers of cursor escapes therefore need to be **converted to printable
 * characters**, not just stripped, before the option regex can match:
 *
 *  1. CUF (`\x1b[<N>C`, cursor forward N columns) is how Claude renders the
 *     space between the option number and its text. Stripping it without
 *     substitution would collapse `2. \ucf54\ub4dc` into `2.\ucf54\ub4dc`, defeating the
 *     `\d+\.\s+\S` regex.
 *  2. CUP (`\x1b[<row>;<col>H`, cursor position) is how Claude places each
 *     option on its own terminal row. Stripping it without substitution
 *     concatenates every option into one long line, defeating the
 *     `(?:^|[\s\u2502|])` line-start anchor in the numbered-option regex.
 *
 * Without these conversions only the first option (which uses literal
 * spaces) matches, the count never reaches the two-options floor, and the
 * detector silently refuses to fire on real WSL Claude sessions. The unit-
 * test fixtures use plain text with literal newlines and spaces, so they
 * pass without this step \u2014 every regression must be guarded by a fixture
 * that includes real CUP/CUF escapes.
 */
function stripAnsi(text: string): string {
  return (
    text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CUP \u2192 newline so options on different terminal rows end up on
      // different text lines. Row/col values are irrelevant for detection.
      .replace(/\x1b\[(?:\d+)?(?:;\d+)?H/g, "\n")
      // CUF(N) \u2192 N spaces. Cap at 200 to defend against a malicious
      // `\x1b[999999C` from blowing memory; real modals use 1\u201310.
      .replace(/\x1b\[(\d+)C/g, (_, n) => " ".repeat(Math.min(parseInt(n, 10), 200)))
      .replace(/\x1b\[C/g, " ")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  );
}

/**
 * Returns true when the rolling output window currently shows a Claude Code
 * permission / response prompt.
 *
 * Claude Code renders prompts like:
 *   \u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e
 *   \u2502 Do you want to make this edit?      \u2502
 *   \u2502 \u276f 1. Yes                            \u2502
 *   \u2502   2. Yes, and don't ask again       \u2502
 *   \u2502   3. No                             \u2502
 *   \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f
 *
 * Detection requires BOTH the arrow-prefixed option AND at least two numbered
 * lines, because the arrow alone matches the steady-state Claude input prompt
 * once the user starts typing literal `1. text` after `\u2570\u2500\u276f ` \u2014 the two-options
 * floor cleanly excludes that case while still firing for every real modal.
 */
export function detectClaudeInputPendingFromOutput(text: string): boolean {
  const plain = stripAnsi(text);
  if (!CLAUDE_ARROWED_OPTION.test(plain)) return false;
  const matches = plain.match(CLAUDE_NUMBERED_OPTION);
  return (matches?.length ?? 0) >= 2;
}

/**
 * Returns true when the rolling window currently shows a Claude modal.
 *
 * IMPORTANT: do not gate on `nextText.includes(❯)`. WSL/ConPTY splits a
 * single modal frame across many small PTY chunks; the arrow lands in
 * chunk 1 and the numbered options arrive in later chunks via cursor
 * positioning (`\x1b[17;3H2.`), not `\r\n`. A naive early-return on
 * "no arrow in this chunk" would refuse to fire on every continuation
 * chunk even though the combined buffer holds a complete modal — that
 * is exactly the silent-fail mode reported by the user.
 *
 * De-duplication of repeat notifications is the call site's job (via
 * the `CLAUDE_INPUT_PENDING_MARKER` on `activityMessage`). The marker
 * is cleared by `TerminalView` which also resets the buffer it owns,
 * so the detector cannot keep re-firing on stale modal residue after
 * the user has answered.
 */
export function detectNewClaudeInputPendingPrompt(previousText: string, nextText: string): boolean {
  const combinedText = `${previousText}${nextText}`.slice(-CLAUDE_DETECTION_WINDOW);
  return detectClaudeInputPendingFromOutput(combinedText);
}

/**
 * Returns true when a previously visible Claude modal should be considered
 * resolved. Claude's normal prompt also contains `❯` (`╰─❯ `), so dismissal
 * cannot be keyed only on "no arrow in the recent output".
 *
 * Three sufficient signals:
 *   1. Claude's normal `╰─❯ ` input prompt is visible again.
 *   2. The buffer contains no selection arrow at all.
 *   3. The full modal pattern is no longer present in the rolling
 *      buffer. The detector requires `❯ N. text` (the arrow-prefixed
 *      selectable option) **and** ≥2 numbered option lines — both
 *      signals are unique to a live modal frame. Once Claude redraws
 *      into a working spinner or a conversation response the
 *      numbered-option count drops below threshold and dismissal can
 *      fire even if a stray `❯` from conversation text still lives
 *      in the 4 KB rolling window. Release v0.3.8 reproduced a stuck
 *      `requiresAction` notification with 22 ❯ characters in the
 *      buffer but only a single `❯ 4. INFO 로그…` arrowed option —
 *      detection returned false and the original two-clause check
 *      kept the marker pinned forever.
 */
export function shouldDismissClaudeInputPendingFromOutput(text: string): boolean {
  const plain = stripAnsi(text);
  if (CLAUDE_NORMAL_INPUT_PROMPT.test(plain)) return true;
  if (!plain.includes(CLAUDE_SELECTION_ARROW)) return true;
  return !detectClaudeInputPendingFromOutput(plain);
}

/**
 * Extracts the latest Claude Code recap summary from a rolling output window,
 * or `undefined` when none is present.
 *
 * Claude's recap feature prints `※ recap: <one-line summary> (disable recaps
 * in /config)` into the scrollback when the user returns to an unfocused
 * session (or runs `/recap`). The summary is drawn in alt-screen mode and
 * wrapped across several rows: continuation rows are placed with CUP
 * (`\x1b[<row>;<col>H`) and indented with CUF (`\x1b[<n>C`) / literal spaces.
 * A plain SGR-only strip would leave those fragments concatenated with no
 * separators, so this MUST reuse the module's `stripAnsi` (CUP→`\n`,
 * CUF(N)→N spaces) before matching — the same conversion the modal detector
 * depends on. After matching, the captured body's whitespace runs (including
 * the synthesised newlines/indents) are collapsed back into the original
 * single-line summary.
 *
 * The buffer can hold several stacked recaps (one per return-to-session), so
 * the global pattern is walked to completion and the LAST capture wins.
 */
export function detectClaudeRecapFromOutput(text: string): string | undefined {
  const plain = stripAnsi(text);
  CLAUDE_RECAP_PATTERN.lastIndex = 0;
  let lastSummary: string | undefined;
  for (
    let match = CLAUDE_RECAP_PATTERN.exec(plain);
    match;
    match = CLAUDE_RECAP_PATTERN.exec(plain)
  ) {
    const summary = match[1].replace(/\s+/g, " ").trim();
    if (summary) lastSummary = summary;
  }
  return lastSummary;
}

/** Known interactive apps without dedicated provider handlers. */
const STATIC_INTERACTIVE_APPS: { title: string; command: string; name: string }[] = [
  { title: "nvim", command: "nvim", name: "neovim" },
  { title: "vim", command: "vim", name: "vim" },
  { title: "vi", command: "vi", name: "vim" },
  { title: "nano", command: "nano", name: "nano" },
  { title: "htop", command: "htop", name: "htop" },
  { title: "btop", command: "btop", name: "btop" },
  { title: "less", command: "less", name: "less" },
  { title: "python3", command: "python3", name: "python" },
  { title: "python", command: "python", name: "python" },
  { title: "node", command: "node", name: "node" },
  { title: "ipython", command: "ipython", name: "ipython" },
];

function normalizeOutputLines(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isCodexFooterStatusLine(line: string): boolean {
  const parts = line.split(new RegExp(`\\s+${MIDDLE_DOT}\\s+`));
  return (
    parts.length >= 3 &&
    /\b\d+% left\b/i.test(parts[1] ?? "") &&
    /(^gpt-|^o[134]\b|^codex\b)/i.test(parts[0] ?? "") &&
    Boolean(parts[2])
  );
}

export function isCodexAssistantMessage(line: string): boolean {
  if (!line.startsWith(`${ASSISTANT_BULLET} `)) return false;
  const message = line.slice(2).trim();
  if (!message) return false;
  if (
    message.startsWith("Ran ") ||
    message.startsWith("Running ") ||
    message.startsWith("Reason:") ||
    message.startsWith("Would you like to run") ||
    message.startsWith("Press enter to confirm") ||
    message.startsWith("Yes, proceed") ||
    message.startsWith("No, and tell Codex") ||
    message.startsWith("Tip:")
  ) {
    return false;
  }
  return true;
}

/** Detect interactive app from terminal title (OSC 0/2). */
export function detectActivityFromTitle(title: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromTitle(title);
  if (registered) return registered;

  if (title.includes("/") || title.includes("\\")) return undefined;

  for (const app of STATIC_INTERACTIVE_APPS) {
    const pattern = new RegExp(
      `(?:^|[\\s\\-:])${app.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s\\-:])`,
    );
    if (pattern.test(title) || title === app.title) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}

/** Detect interactive app from raw output text when command/title signals are unavailable. */
export function detectActivityFromOutput(text: string): TerminalActivityInfo | undefined {
  const lines = normalizeOutputLines(text);
  // Codex 0.120+ draws the startup banner inside a box (`│ >_ OpenAI Codex … │`)
  // while older builds emitted it bare (`> OpenAI Codex …`). Allow optional
  // leading box-drawing chars and optional trailing padding; the `>_` /`>`
  // prompt marker + version `(v…)` is still the uniquely identifying signal.
  const hasCodexBanner = lines.some((line) =>
    /^[│|]?\s*>[-\s_]*OpenAI Codex \(v[^\s)]+\)\s*[│|]?\s*$/i.test(line),
  );
  const hasCodexSessionMetadata = lines.some(
    (line) => /^\s*[│|]?\s*model:\s+/i.test(line) || /^\s*[│|]?\s*directory:\s+/i.test(line),
  );
  if (hasCodexBanner && hasCodexSessionMetadata) {
    return { type: "interactiveApp", name: "Codex" };
  }
  return undefined;
}

export function detectCodexInputPendingFromOutput(text: string): boolean {
  return (
    text.includes("Would you like to run the following command?") ||
    text.includes("Press enter to confirm or esc to cancel") ||
    text.includes("command?") ||
    text.includes("confirm or esc to cancel") ||
    text.includes("esc to cancel") ||
    text.includes("to cancel") ||
    text.includes("Reason:") ||
    text.includes("Would you like to run") ||
    text.includes("Yes, proceed") ||
    text.includes("No, and tell Codex what to do differently") ||
    text.includes("tell Codex what to do differently")
  );
}

export function detectNewCodexInputPendingPrompt(previousText: string, nextText: string): boolean {
  const combinedText = `${previousText}${nextText}`.slice(-1024);
  const strictPromptPattern =
    /(?:Would you like to run the following command\?|Press enter to confirm or esc to cancel)/;
  return strictPromptPattern.test(combinedText) && !strictPromptPattern.test(previousText);
}

export function detectCodexConversationMessageFromOutput(text: string): string | undefined {
  const lines = normalizeOutputLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!isCodexAssistantMessage(line)) continue;
    return line.slice(2).trim();
  }
  return undefined;
}

export function detectCodexStatusMessageFromOutput(text: string): string | undefined {
  const lines = normalizeOutputLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isCodexFooterStatusLine(line)) {
      return line;
    }
  }
  return undefined;
}

/** Detect interactive app from command text (OSC 133 E). */
export function detectActivityFromCommand(command: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromCommand(command);
  if (registered) return registered;

  const trimmed = command.trim();
  if (!trimmed) return undefined;

  let first = trimmed.split(/\s+/)[0];
  if (first === "sudo" && trimmed.split(/\s+/).length > 1) {
    first = trimmed.split(/\s+/)[1];
  }
  const basename = first.split("/").pop() ?? first;

  for (const app of STATIC_INTERACTIVE_APPS) {
    if (basename === app.command) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}
