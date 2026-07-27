/**
 * Cell-grid test harness — a **real** `@xterm/xterm` instance you can stream raw
 * bytes into and read back cell by cell.
 *
 * Why this exists (issue #605). `TerminalView.test.tsx` mocks xterm, and the
 * mock's `write` never reaches a VT parser: it records the string. That is fine
 * for wiring assertions, but it makes a whole class of claim unprovable — every
 * claim of the form *"stream these bytes and the screen ends up like this"*.
 * ADR-0072's Consequences item (7) ("a differential render sequence ends up
 * cell-identical after a repair") is the reason sequence-exact repair exists at
 * all, and with a mocked xterm it could only be argued, never run. So could
 * `reset()`'s real semantics (issue #602) and wide-cell caret geometry (#596).
 *
 * What this harness is:
 *
 * - A real `Terminal`, constructed **without** `open()`. No renderer, no canvas,
 *   no `document` layout — just the VT parser and the buffer, which is exactly
 *   the layer these claims live in. Confirmed in jsdom: `write()` parses,
 *   `buffer.active.getLine(y)` reads back, `reset()` fires `onScroll`
 *   synchronously, and wide/combining widths come out of xterm's own tables.
 * - Wired to the production Unicode provider (`activateTerminalUnicodeProvider`,
 *   ADR-0058) before the first write, in the same order `TerminalView` does it.
 *   Without that, cell widths here would be xterm's defaults and would not match
 *   what ships.
 *
 * What it is **not**: a `TerminalView` test. It has no React, no store, no Tauri.
 * Assertions about the component's effects stay in `TerminalView.test.tsx`.
 *
 * Screen tests live in `*.screen.test.ts` and run in their own vitest project
 * (`ui/vitest.screen.config.ts`, `npm run test:screen`) so the default suite
 * keeps its runtime (ADR-0074).
 */

import { Terminal } from "@xterm/xterm";
import type { IBufferCell } from "@xterm/xterm";
import { activateTerminalUnicodeProvider } from "@/lib/terminal-unicode-width";

/** One buffer cell, reduced to everything that can make two screens differ. */
export interface ScreenCell {
  /** Cell contents; `""` for the continuation half of a wide char. */
  chars: string;
  /** xterm's own width: 2 for East Asian Wide, 0 for a wide char's second half. */
  width: number;
  /** `"{mode}:{color}"` — mode distinguishes default/palette/RGB. */
  fg: string;
  bg: string;
  /** Compact flag string, e.g. `"bold,inverse"`; `""` when unstyled. */
  attrs: string;
}

export interface ScreenRow {
  /** `translateToString(false)` — trailing blanks kept, so columns line up. */
  text: string;
  cells: ScreenCell[];
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  /** Scrollback height at capture time. */
  baseY: number;
  bufferType: "normal" | "alternate";
  /** Cursor in viewport coordinates, as xterm reports it (may equal `cols`). */
  cursor: { x: number; y: number };
  /** The visible viewport, top row first. */
  viewport: ScreenRow[];
}

export interface ScreenTerminalOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export interface ScreenTerminal {
  readonly terminal: Terminal;
  /**
   * `ybase` reported by every `onScroll` since construction, in order. Kept
   * because `reset()` emits one synchronously and the mock never did — that
   * event is the mechanism behind issue #602.
   */
  readonly scrollEvents: readonly number[];
  /** Write bytes and resolve once xterm has parsed them. */
  write(data: string | Uint8Array): Promise<void>;
  /** Real `terminal.reset()`; listeners fire exactly as they do in production. */
  reset(): void;
  capture(): ScreenSnapshot;
  dispose(): void;
}

export function createScreenTerminal(options: ScreenTerminalOptions = {}): ScreenTerminal {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
  });
  // Same order as TerminalView: provider first, then any write (ADR-0058).
  activateTerminalUnicodeProvider(terminal);
  const scrollEvents: number[] = [];
  terminal.onScroll((ybase) => scrollEvents.push(ybase));
  return {
    terminal,
    scrollEvents,
    write: (data) => new Promise<void>((resolve) => terminal.write(data, resolve)),
    reset: () => terminal.reset(),
    capture: () => captureScreen(terminal),
    dispose: () => terminal.dispose(),
  };
}

/** Snapshot the visible viewport, cell by cell. */
export function captureScreen(terminal: Terminal): ScreenSnapshot {
  const buffer = terminal.buffer.active;
  const viewport: ScreenRow[] = [];
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.baseY + y);
    if (!line) {
      viewport.push({ text: "", cells: [] });
      continue;
    }
    const cells: ScreenCell[] = [];
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line.getCell(x);
      cells.push(
        cell
          ? {
              chars: cell.getChars(),
              width: cell.getWidth(),
              fg: `${cell.getFgColorMode()}:${cell.getFgColor()}`,
              bg: `${cell.getBgColorMode()}:${cell.getBgColor()}`,
              attrs: describeAttrs(cell),
            }
          : { chars: "", width: 0, fg: "", bg: "", attrs: "" },
      );
    }
    viewport.push({ text: line.translateToString(false), cells });
  }
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    baseY: buffer.baseY,
    bufferType: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    viewport,
  };
}

const ATTR_FLAGS: Array<[string, (cell: IBufferCell) => boolean]> = [
  ["bold", (cell) => cell.isBold() !== 0],
  ["dim", (cell) => cell.isDim() !== 0],
  ["italic", (cell) => cell.isItalic() !== 0],
  ["underline", (cell) => cell.isUnderline() !== 0],
  ["blink", (cell) => cell.isBlink() !== 0],
  ["inverse", (cell) => cell.isInverse() !== 0],
  ["invisible", (cell) => cell.isInvisible() !== 0],
  ["strike", (cell) => cell.isStrikethrough() !== 0],
  ["overline", (cell) => cell.isOverline() !== 0],
];

function describeAttrs(cell: IBufferCell): string {
  return ATTR_FLAGS.filter(([, read]) => read(cell))
    .map(([name]) => name)
    .join(",");
}

export interface ScreenDiffOptions {
  /**
   * Compare the cursor cell too. On by default: a sequence-exact repair
   * reproduces the byte stream, so it has to land the cursor as well.
   */
  compareCursor?: boolean;
  /** Stop after this many differing cells. */
  maxCellReports?: number;
}

/**
 * Compare two screens cell by cell.
 *
 * Returns `null` when they are identical, otherwise a human-readable report.
 * Returning a string rather than throwing keeps the harness usable for the
 * inverse assertion — "this recovery path does **not** restore the screen" —
 * which is how the defect in issue #600 is proven to exist.
 */
export function diffScreens(
  expected: ScreenSnapshot,
  actual: ScreenSnapshot,
  options: ScreenDiffOptions = {},
): string | null {
  const compareCursor = options.compareCursor ?? true;
  const maxCellReports = options.maxCellReports ?? 8;
  const problems: string[] = [];
  if (expected.cols !== actual.cols || expected.rows !== actual.rows) {
    return `geometry differs: ${expected.cols}x${expected.rows} vs ${actual.cols}x${actual.rows}`;
  }
  if (expected.bufferType !== actual.bufferType) {
    problems.push(`buffer type: ${expected.bufferType} vs ${actual.bufferType}`);
  }
  if (
    compareCursor &&
    (expected.cursor.x !== actual.cursor.x || expected.cursor.y !== actual.cursor.y)
  ) {
    problems.push(
      `cursor: (${expected.cursor.x},${expected.cursor.y}) vs (${actual.cursor.x},${actual.cursor.y})`,
    );
  }
  let reported = 0;
  for (let y = 0; y < expected.rows; y += 1) {
    const expectedRow = expected.viewport[y];
    const actualRow = actual.viewport[y];
    if (expectedRow.text === actualRow.text && sameCells(expectedRow, actualRow)) continue;
    if (reported < maxCellReports) {
      problems.push(
        `row ${y}:\n  expected ${JSON.stringify(expectedRow.text)}\n  actual   ${JSON.stringify(actualRow.text)}`,
      );
      for (let x = 0; x < expected.cols && reported < maxCellReports; x += 1) {
        const a = expectedRow.cells[x];
        const b = actualRow.cells[x];
        if (sameCell(a, b)) continue;
        problems.push(`  cell (${x},${y}): ${formatCell(a)} vs ${formatCell(b)}`);
        reported += 1;
      }
    }
  }
  return problems.length > 0 ? problems.join("\n") : null;
}

function sameCells(expected: ScreenRow, actual: ScreenRow): boolean {
  if (expected.cells.length !== actual.cells.length) return false;
  return expected.cells.every((cell, index) => sameCell(cell, actual.cells[index]));
}

function sameCell(expected: ScreenCell, actual: ScreenCell): boolean {
  return (
    expected.chars === actual.chars &&
    expected.width === actual.width &&
    expected.fg === actual.fg &&
    expected.bg === actual.bg &&
    expected.attrs === actual.attrs
  );
}

function formatCell(cell: ScreenCell): string {
  return `${JSON.stringify(cell.chars)}(w${cell.width} fg${cell.fg} bg${cell.bg}${
    cell.attrs ? ` ${cell.attrs}` : ""
  })`;
}

/** Render a snapshot as numbered rows — for failure messages and debugging. */
export function formatScreen(snapshot: ScreenSnapshot): string {
  const header = `${snapshot.cols}x${snapshot.rows} baseY=${snapshot.baseY} buffer=${snapshot.bufferType} cursor=(${snapshot.cursor.x},${snapshot.cursor.y})`;
  const rows = snapshot.viewport.map(
    (row, y) => `${String(y).padStart(2, " ")}|${row.text.replace(/\s+$/, "")}`,
  );
  return [header, ...rows].join("\n");
}

/** Rows of the visible viewport as strings — the coarse read for readable tests. */
export function screenRows(snapshot: ScreenSnapshot): string[] {
  return snapshot.viewport.map((row) => row.text);
}

/** One viewport row, trailing blanks trimmed. */
export function screenRow(snapshot: ScreenSnapshot, y: number): string {
  return (snapshot.viewport[y]?.text ?? "").replace(/\s+$/, "");
}
