/**
 * Smart text transforms for clipboard paste and copy.
 *
 * Copy transforms:
 * - trimSelectionTrailingWhitespace — strip trailing whitespace from xterm.js selection
 *
 * Paste transforms:
 * 1. smartRemoveIndent — strip common leading whitespace from all lines
 * 2. smartRemoveLineBreak — rejoin URLs that were split across lines
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
 * Detect if the entire text (when all newlines are removed) forms a single URL.
 * If so, join lines by removing newlines.
 *
 * Scope: http:// and https:// only. The \S+ pattern intentionally doesn't
 * validate URL structure — in a clipboard-paste context, false positives
 * (non-standard chars in a URL-shaped string) are harmless.
 */
export function smartRemoveLineBreak(text: string): string {
  if (!text || !text.includes("\n")) return text;

  // Check if joining all lines produces a valid-looking URL
  const joined = text.split("\n").join("");

  // Must start with http:// or https://
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
