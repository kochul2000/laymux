/**
 * Represents a paragraph extracted from memo text.
 * startLine / endLine are 0-based line indices (inclusive).
 */
export interface Paragraph {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split text into paragraphs separated by N or more consecutive blank lines.
 *
 * A "blank line" is a line that is empty or contains only whitespace.
 * Leading/trailing blank lines are trimmed from each paragraph.
 * Paragraphs that are entirely blank after trimming are discarded.
 *
 * @param text The full memo text
 * @param minBlankLines Minimum number of consecutive blank lines to trigger a split (default: 2)
 * @returns Array of Paragraph objects
 */
export function splitParagraphs(text: string, minBlankLines: number): Paragraph[] {
  const lines = text.split("\n");

  // Find split points: indices where minBlankLines consecutive blank lines START
  const isBlank = (line: string) => line.trim() === "";

  // Group consecutive lines into paragraphs by finding separator regions
  const paragraphs: Paragraph[] = [];
  let i = 0;

  while (i < lines.length) {
    // Skip leading blank lines
    if (isBlank(lines[i])) {
      i++;
      continue;
    }

    // Start of a paragraph
    const start = i;
    let end = i;

    while (i < lines.length) {
      // Check if we hit a separator (minBlankLines consecutive blanks)
      if (isBlank(lines[i])) {
        let blankCount = 0;
        let j = i;
        while (j < lines.length && isBlank(lines[j])) {
          blankCount++;
          j++;
        }

        if (blankCount >= minBlankLines) {
          // This is a separator - end the paragraph before the blanks
          break;
        } else {
          // Not enough blanks to be a separator - include them in the paragraph
          end = j - 1;
          i = j;
        }
      } else {
        end = i;
        i++;
      }
    }

    // Extract paragraph text (from start to end inclusive)
    const paragraphText = lines.slice(start, end + 1).join("\n");
    paragraphs.push({ text: paragraphText, startLine: start, endLine: end });

    // Skip separator blank lines
    while (i < lines.length && isBlank(lines[i])) {
      i++;
    }
  }

  return paragraphs;
}
