/**
 * Smart text transforms for clipboard paste and copy.
 *
 * Copy transforms:
 * - trimSelectionTrailingWhitespace — strip trailing whitespace from xterm.js selection
 * - prepareSelectionForCopy — trim + optional smartRemoveIndent + optional smartRemoveLineBreak
 *
 * Paste transforms:
 * 1. smartRemoveIndent — strip common leading whitespace from all lines
 * 2. smartRemoveLineBreak — rejoin URLs that were split across lines
 *    (strips all internal whitespace, including spaces left over after an
 *    external paste already removed the newlines)
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
 * Detect if the entire text (when all whitespace is removed) forms a single URL.
 * If so, return the whitespace-stripped form. Otherwise return the input unchanged.
 *
 * Handles three shapes that all collapse to the same clean URL:
 *   1. Multi-line URL with newlines only — split by terminal hard-wrap.
 *   2. Multi-line URL with newlines + indent + buffer-pad spaces.
 *   3. Single-line URL where an upstream paste target stripped newlines but
 *      left leading-indent + trailing-pad as internal gaps.
 *
 * URLs forbid raw spaces, so stripping all whitespace is safe when the content
 * is recognisably a URL.
 *
 * Scope: http:// and https:// only. The \S+ pattern intentionally doesn't
 * validate URL structure — in a clipboard context, false positives
 * (non-standard chars in a URL-shaped string) are harmless.
 */
export function smartRemoveLineBreak(text: string): string {
  if (!text) return text;

  const joined = text.replace(/\s+/g, "");

  if (/^https?:\/\/\S+$/.test(joined)) {
    return joined;
  }

  return text;
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
