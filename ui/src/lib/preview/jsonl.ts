/**
 * JSON Lines → per-line records for the structured file-viewer preview
 * (ADR-0109). Pure data in, pure data out — no DOM, no HTML strings.
 *
 * Every line is parsed on its own. Agent transcripts are the main consumer and
 * they are routinely read while still being written, so the last line is often
 * a half-flushed fragment. One broken line must cost exactly that line.
 */

export interface JsonlRecord {
  /** 1-based line number in the source file. */
  line: number;
  raw: string;
  /** Present when the line parsed as JSON. */
  value?: unknown;
  /** Present when it did not. */
  error?: string;
}

export interface JsonlResult {
  records: JsonlRecord[];
  /** Total non-blank lines in the file, even when `records` is capped. */
  totalRecords: number;
  truncated: boolean;
  invalidCount: number;
}

export const MAX_JSONL_RECORDS = 2_000;

const DEFAULT_SUMMARY_LENGTH = 200;

export function parseJsonl(text: string, options?: { maxRecords?: number }): JsonlResult {
  const maxRecords = Math.max(0, options?.maxRecords ?? MAX_JSONL_RECORDS);
  const records: JsonlRecord[] = [];
  let totalRecords = 0;
  let invalidCount = 0;
  let truncated = false;

  // Splitting on /\r?\n/ covers CRLF files and leaves a trailing "" when the
  // file ends with a newline — that "" is blank, so a missing final newline
  // produces the identical record list.
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    // Blank lines are not records, but they still consume a line number: the
    // numbers have to match what the user sees in their editor.
    if (raw.trim().length === 0) continue;
    totalRecords += 1;

    let value: unknown;
    let error: string | undefined;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    // Counted before the cap check so the tally describes the whole file, not
    // just the visible slice.
    if (error !== undefined) invalidCount += 1;

    if (records.length >= maxRecords) {
      truncated = true;
      continue;
    }
    records.push(
      error === undefined ? { line: index + 1, raw, value } : { line: index + 1, raw, error },
    );
  }

  return { records, totalRecords, truncated, invalidCount };
}

/** Compact single-line label for a collapsed row. */
export function summarizeJsonlValue(value: unknown, maxLength = DEFAULT_SUMMARY_LENGTH): string {
  const text = compactJson(value);
  if (text.length <= maxLength) return text;
  // The ellipsis is part of the budget, so the label never exceeds maxLength.
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function compactJson(value: unknown): string {
  // JSON.parse can only hand back objects, arrays, strings, numbers, booleans
  // and null, all of which JSON.stringify round-trips on one line. The guards
  // exist purely so a caller passing something else (undefined, a BigInt) gets
  // a label instead of an exception — this helper is not worth a special case
  // per exotic type.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
