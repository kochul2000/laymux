/**
 * Smart text transforms for clipboard paste and copy.
 *
 * Copy transforms:
 * - trimSelectionTrailingWhitespace — strip trailing whitespace from xterm.js selection
 * - prepareSelectionForCopy — trim + optional smartRemoveIndent + optional smartRemoveLineBreak
 *
 * Paste transforms:
 * 1. smartRemoveIndent — strip common leading whitespace from all lines
 * 2. smartRemoveLineBreak — rejoin a URL that was broken by terminal padding
 *    or upstream newline-strip (collapses padding-like whitespace runs only;
 *    natural-language single ASCII spaces between tokens are preserved on
 *    both copy and paste paths).
 *
 * The correct order is: indent first, then linebreak.
 * If linebreak ran on indented text, the indent spaces would corrupt URLs.
 */

/**
 * Remove trailing whitespace from each line, then remove trailing blank lines.
 *
 * xterm.js getSelection() pads each line with trailing spaces to fill the
 * terminal width, and includes empty lines at the end of the selection.
 * This function cleans up the selection text before writing to clipboard.
 */
export function trimSelectionTrailingWhitespace(text: string): string {
  if (!text) return text;

  // Detect line ending style (CRLF vs LF)
  const hasCRLF = text.includes("\r\n");
  const lineEnding = hasCRLF ? "\r\n" : "\n";
  const lines = text.split(lineEnding);

  // Remove trailing whitespace from each line
  const trimmed = lines.map((line) => line.replace(/[ \t]+$/, ""));

  // Remove trailing blank lines
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }

  return trimmed.join(lineEnding);
}

export interface CopyOptions {
  smartRemoveIndent: boolean;
  /**
   * Optional. When true, additionally rejoin a multi-line URL into a single
   * line at copy time and strip any internal whitespace. Without this, an
   * external app that strips newlines on paste (e.g. browser address bar)
   * would still see the leading-indent + trailing-pad as gaps inside the URL.
   */
  smartRemoveLineBreak?: boolean;
}

/**
 * Prepare xterm.js selection text for clipboard copy.
 *
 * Always applies trimSelectionTrailingWhitespace (remove trailing spaces/blank lines).
 * When smartRemoveIndent is enabled, also removes common leading whitespace so that
 * text copied from terminal doesn't carry unwanted indentation into external apps.
 * When smartRemoveLineBreak is enabled, a multi-line URL selection is collapsed to a
 * single clean URL so external paste targets don't end up with whitespace inside it.
 */
export function prepareSelectionForCopy(text: string, options: CopyOptions): string {
  let result = trimSelectionTrailingWhitespace(text);
  if (options.smartRemoveIndent) {
    result = smartRemoveIndent(result);
  }
  if (options.smartRemoveLineBreak) {
    result = smartRemoveLineBreak(result);
  }
  return result;
}

/**
 * Remove the common leading whitespace (spaces/tabs) from every line.
 * Blank lines are ignored when computing the common prefix but are preserved in output.
 */
export function smartRemoveIndent(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");

  // Find the minimum indent among non-blank lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue; // skip blank lines
    const match = line.match(/^([ \t]*)/);
    if (match) {
      minIndent = Math.min(minIndent, match[1].length);
    }
  }

  if (minIndent === 0 || minIndent === Infinity) return text;

  return lines
    .map((line) => {
      if (line.trim().length === 0) return line; // preserve blank lines
      return line.slice(minIndent);
    })
    .join("\n");
}

/**
 * Rejoin a URL token that terminal / TUI wrapping split across lines, dropping
 * each continuation line's leading indent.
 *
 * Why this is needed beyond the whole-text-is-a-URL collapse below: full-screen
 * TUIs (e.g. Claude Code's input box) render a long line with their OWN layout
 * — a constant left indent on every continuation row, broken with explicit
 * cursor moves rather than terminal auto-wrap. xterm therefore stores those
 * rows as separate, non-`isWrapped` lines, so `getSelection()` joins them with
 * newlines and keeps the indent. The result is a command like
 *   `gws --scopes "https://a.com/x,https://a.com/y,..."`
 * coming back with newlines + 2-space gaps wedged inside the URLs. Such a
 * selection is not a single URL, so it never reached the collapse path.
 *
 * A line break is treated as a wrap artefact (removed, continuation indent
 * stripped) only when ALL of these hold, which keeps prose and bare URL lists
 * intact:
 *   - the text so far ends inside a URL run — its trailing whitespace-free
 *     segment contains an `http(s)://` scheme;
 *   - the continuation (after indent strip) is a single whitespace-free token —
 *     prose like `hello world` has internal spaces and is left alone;
 *   - the continuation contains a URL-structural char (`/ : ? = & % # @`) — a
 *     plain prose word like `Thanks` after a URL line is NOT a wrapped tail, so
 *     `See https://x.com/page\nThanks` is left alone. `.` and `,` are excluded
 *     because they are common in prose. Limitation: a URL wrapped mid-segment
 *     onto a purely alphanumeric tail (`...com/pa` + `th`) is not merged here —
 *     when the whole selection is one URL, the Phase-2 collapse still repairs
 *     it; embedded in a command it stays broken. This favours leaving a visible
 *     break over silently gluing prose, which corrupts text unrecoverably.
 *   - the continuation does NOT itself start a new scheme — `https://b.com` on
 *     its own line is a separate URL, not a wrapped tail.
 *
 * `tail` and `continuation` are computed with trailing pad stripped so the
 * decision holds on the paste path too, where smartRemoveLineBreak runs without
 * a prior trimSelectionTrailingWhitespace.
 */
function mergeWrappedUrlLines(text: string): string {
  if (!/\r?\n/.test(text)) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  let result = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const continuation = lines[i].replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    const resultTrimmedEnd = result.replace(/[ \t]+$/, "");
    const tail = /\S*$/.exec(resultTrimmedEnd)?.[0] ?? "";
    const isWrappedUrlTail =
      continuation.length > 0 &&
      /^\S+$/.test(continuation) &&
      /[/:?=&%#@]/.test(continuation) &&
      !/^https?:\/\//.test(continuation) &&
      /https?:\/\//.test(tail);
    if (isWrappedUrlTail) {
      result = resultTrimmedEnd + continuation;
    } else {
      result += eol + lines[i];
    }
  }
  return result;
}

/**
 * Repair URLs broken by terminal / TUI line wrapping.
 *
 * Two passes:
 *   1. `mergeWrappedUrlLines` rejoins a URL token split across lines (the TUI
 *      input-box case above) while preserving prose and bare URL lists.
 *   2. If, after merging, the whole text (with all whitespace removed) forms a
 *      single URL AND every internal whitespace run looks like terminal padding
 *      / wrap leftover, return the whitespace-stripped form. A lone ASCII space
 *      between tokens is treated as prose and preserved, so inputs like
 *        "https://x.com hello world"   (single-line URL + prose)
 *        "https://x.com\nhello world"  (URL on line 1, prose on line 2)
 *      survive intact. The shapes that collapse:
 *        a. Multi-line URL split by terminal hard-wrap.
 *        b. Multi-line URL with leading indent + trailing buffer-pad per line.
 *        c. Single-line URL where an upstream paste target stripped newlines but
 *           left leading-indent + trailing-pad as ≥2-char internal gaps, or tabs.
 *
 * "Padding-like" run = contains a newline / CR / tab, or is ≥2 ASCII spaces.
 * URLs forbid raw whitespace, so collapsing is safe once we have decided the
 * input is URL-shaped and the gaps look like artefacts.
 *
 * Scope: http:// and https:// only. The \S+ pattern intentionally doesn't
 * validate URL structure — in a clipboard context, false positives
 * (non-standard chars in a URL-shaped string) are harmless.
 */
export function smartRemoveLineBreak(text: string): string {
  if (!text) return text;

  const merged = mergeWrappedUrlLines(text);

  const joined = merged.replace(/\s+/g, "");
  if (!/^https?:\/\/\S+$/.test(joined)) return merged;

  // Only collapse when every internal whitespace run looks like terminal
  // padding / wrap leftover. A lone ASCII space is the prose signature.
  const trimmed = merged.replace(/^\s+/, "").replace(/\s+$/, "");
  const internalRuns = trimmed.match(/\s+/g) ?? [];
  const allRunsLookLikePadding = internalRuns.every(
    (run) => run.length >= 2 || /[\t\r\n]/.test(run),
  );
  if (!allRunsLookLikePadding) return merged;

  return joined;
}

export interface SmartTextOptions {
  removeIndent: boolean;
  removeLineBreak: boolean;
}

/**
 * Apply smart text transforms in the correct order:
 * 1. Normalize \r\n to \n (Windows clipboard may contain CRLF)
 * 2. Remove common indent
 * 3. Remove line breaks (for URLs)
 */
export function applySmartTextTransforms(text: string, options: SmartTextOptions): string {
  let result = text.replace(/\r\n/g, "\n");
  if (options.removeIndent) {
    result = smartRemoveIndent(result);
  }
  if (options.removeLineBreak) {
    result = smartRemoveLineBreak(result);
  }
  return result;
}

/**
 * Apply transforms to text that is being pasted into a terminal.
 *
 * Paste is not copy cleanup. External clipboard text may be a formatted review
 * note, table, patch, or here-doc where leading whitespace is meaningful.
 * Therefore paste only repairs URL wrapping; common-indent removal remains a
 * copy-time transform via `prepareSelectionForCopy`.
 */
export function applyPasteTextTransforms(text: string, options: SmartTextOptions): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!options.removeLineBreak) return normalized;
  return smartRemoveLineBreak(normalized);
}

/**
 * Separator token for joining multiple pasted file paths (issue #325).
 * Stored as a token (not the raw char) so settings.json stays readable
 * and the Settings UI can render a labelled dropdown.
 */
export type PastePathSeparator = "space" | "newline" | "comma" | "semicolon";

const PASTE_PATH_SEPARATOR_CHARS: Record<PastePathSeparator, string> = {
  space: " ",
  newline: "\n",
  comma: ",",
  semicolon: ";",
};

export interface PastePathOptions {
  /** Separator token between paths. Unknown tokens fall back to "space". */
  separator: PastePathSeparator;
  /** Wrap each path in double quotes (useful for paths containing spaces). */
  quote: boolean;
}

/**
 * Join multiple clipboard file paths into a single paste string.
 *
 * Used when the user copies several files in Explorer and pastes them into
 * a terminal: each resolved path is optionally quote-wrapped, then joined
 * with the configured separator (default: space).
 */
export function formatPastePaths(paths: string[], options: PastePathOptions): string {
  const sep = PASTE_PATH_SEPARATOR_CHARS[options.separator] ?? " ";
  const items = options.quote ? paths.map((p) => `"${p}"`) : paths;
  return items.join(sep);
}

/** Transform paste result content shared by Ctrl+V and right-click paste. */
export function transformPasteContent(
  content: string,
  pasteType: string,
  convenience: SmartTextOptions,
): string {
  if (pasteType !== "text") return content;
  return applyPasteTextTransforms(content, convenience);
}
