/**
 * Smart text transforms for clipboard paste.
 *
 * 1. smartRemoveIndent — strip common leading whitespace from all lines
 * 2. smartRemoveLineBreak — rejoin URLs that were split across lines
 *
 * The correct order is: indent first, then linebreak.
 * If linebreak ran on indented text, the indent spaces would corrupt URLs.
 */

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
 * Currently only applies to http:// and https:// URLs.
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
 * 1. Remove common indent
 * 2. Remove line breaks (for URLs)
 */
export function applySmartTextTransforms(text: string, options: SmartTextOptions): string {
  let result = text;
  if (options.removeIndent) {
    result = smartRemoveIndent(result);
  }
  if (options.removeLineBreak) {
    result = smartRemoveLineBreak(result);
  }
  return result;
}
