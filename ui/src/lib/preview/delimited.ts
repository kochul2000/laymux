import { fileExtension } from "../file-viewer";

/**
 * CSV/TSV parser for the file-viewer preview. RFC 4180 is the baseline, but the
 * files users actually open are hand-edited exports, so every deviation below
 * is recovered from instead of rejected — a preview must always render
 * something rather than throw.
 */

export interface DelimitedResult {
  rows: string[][];
  /** Widest row's column count — the table renders this many columns. */
  columnCount: number;
  truncated: boolean;
  /** Total rows in the source, even when the cap dropped some. */
  totalRows: number;
}

export const MAX_DELIMITED_ROWS = 2_000;

const TSV_EXTENSIONS = new Set([".tsv", ".tab"]);
const SNIFF_CANDIDATES = [",", ";", "\t", "|"];
const BOM = "\uFEFF";

/** Pick the field separator: extension first, then a sniff of the first data line. */
export function detectDelimiter(path: string, sample: string): string {
  if (TSV_EXTENSIONS.has(fileExtension(path))) return "\t";

  const line = firstNonEmptyLine(sample);
  if (line.length === 0) return ",";

  const counts = new Map<string, number>();
  let inQuotes = false;
  for (const char of line) {
    // Separators inside a quoted field are content; counting them would let a
    // quoted sentence outvote the real separator.
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (SNIFF_CANDIDATES.includes(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let best = ",";
  let bestCount = 0;
  let tied = false;
  for (const candidate of SNIFF_CANDIDATES) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
      tied = false;
    } else if (count > 0 && count === bestCount) {
      tied = true;
    }
  }

  // An ambiguous sniff is worse than a wrong-but-predictable guess.
  return bestCount === 0 || tied ? "," : best;
}

export function parseDelimited(
  text: string,
  delimiter: string,
  options?: { maxRows?: number },
): DelimitedResult {
  const maxRows = options?.maxRows ?? MAX_DELIMITED_ROWS;
  const rows: string[][] = [];
  let columnCount = 0;
  let totalRows = 0;

  // The BOM belongs to the file, not to the first header cell.
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  const endRow = (): void => {
    row.push(field);
    field = "";
    totalRows++;
    if (rows.length < maxRows) {
      rows.push(row);
      columnCount = Math.max(columnCount, row.length);
    }
    row = [];
  };

  while (index < source.length) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index++;
        continue;
      }
      // Delimiters and both newline characters are literal content here.
      field += char;
      index++;
      continue;
    }

    // A quote only opens a field at its very start; anywhere else (`5" tall`)
    // it is data that a strict reader would choke on.
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      index++;
      continue;
    }

    if (delimiter.length > 0 && source.startsWith(delimiter, index)) {
      row.push(field);
      field = "";
      index += delimiter.length;
      continue;
    }

    if (char === "\r") {
      endRow();
      index += source.startsWith("\r\n", index) ? 2 : 1;
      continue;
    }

    if (char === "\n") {
      endRow();
      index++;
      continue;
    }

    field += char;
    index++;
  }

  // A trailing newline already closed its row, so only flush when the tail
  // actually holds something — including an all-empty row such as `,,`. An
  // unterminated quote lands here too, keeping the rest of the file as content.
  if (field.length > 0 || row.length > 0) endRow();

  return { rows, columnCount, truncated: totalRows > maxRows, totalRows };
}

function firstNonEmptyLine(sample: string): string {
  // Scan rather than `split`: only the first line is ever needed, and the
  // sample here is the whole file — splitting it would allocate an array of
  // every row just to read row one.
  let start = 0;
  while (start < sample.length) {
    const breakAt = sample.indexOf("\n", start);
    const end = breakAt === -1 ? sample.length : breakAt;
    const line = sample.slice(start, end > start && sample[end - 1] === "\r" ? end - 1 : end);
    if (line.trim().length > 0) return line;
    if (breakAt === -1) break;
    start = breakAt + 1;
  }
  return "";
}
