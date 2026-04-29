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
 * Detect if the entire text (when all whitespace is removed) forms a single URL,
 * AND every internal whitespace run looks like terminal padding / wrap leftover
 * rather than natural-language word separation. If both hold, return the
 * whitespace-stripped form. Otherwise return the input unchanged.
 *
 * "Padding-like" run = contains a newline / CR / tab, or is ≥2 ASCII spaces.
 * A lone ASCII space between tokens is treated as prose and preserved, so
 * inputs like
 *
 *     "https://x.com hello world"            (single-line URL + prose)
 *     "https://x.com\nhello world"           (URL on line 1, prose on line 2)
 *
 * survive intact on both copy and paste paths. The shapes that DO collapse:
 *
 *     1. Multi-line URL split by terminal hard-wrap (the newline run is the
 *        only whitespace, possibly fused with indent/pad spaces around it).
 *     2. Multi-line URL with leading indent + trailing buffer-pad on each line.
 *     3. Single-line URL where an upstream paste target stripped newlines but
 *        left leading-indent + trailing-pad as ≥2-char internal gaps, or
 *        tabs.
 *
 * URLs forbid raw whitespace, so collapsing is safe once we have decided the
 * input is URL-shaped and the gaps look like artefacts.
 *
 * Scope: http:// and https:// only. The \S+ pattern intentionally doesn't
 * validate URL structure — in a clipboard context, false positives
 * (non-standard chars in a URL-shaped string) are harmless.
 */
export function smartRemoveLineBreak(text: string): string {
  if (!text) return text;

  const joined = text.replace(/\s+/g, "");
  if (!/^https?:\/\/\S+$/.test(joined)) return text;

  // Only collapse when every internal whitespace run looks like terminal
  // padding / wrap leftover. A lone ASCII space is the prose signature.
  const trimmed = text.replace(/^\s+/, "").replace(/\s+$/, "");
  const internalRuns = trimmed.match(/\s+/g) ?? [];
  const allRunsLookLikePadding = internalRuns.every(
    (run) => run.length >= 2 || /[\t\r\n]/.test(run),
  );
  if (!allRunsLookLikePadding) return text;

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
 * Transform paste result content using smart text settings.
 * Centralises the "is it text? → apply transforms" logic shared by
 * Ctrl+V and right-click paste paths.
 */
export function transformPasteContent(
  content: string,
  pasteType: string,
  convenience: SmartTextOptions,
): string {
  if (pasteType !== "text") return content;
  return applySmartTextTransforms(content, convenience);
}
