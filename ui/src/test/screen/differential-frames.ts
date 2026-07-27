/**
 * A codex-shaped differential render script.
 *
 * The whole argument of [ADR-0072] rests on one property of TUIs like codex:
 * **they only write the cells they believe changed.** Frame 0 paints the screen;
 * every later frame moves the cursor somewhere absolute, rewrites a few cells,
 * and erases with `ESC[K` — *from its own column*, never a full-row clear. Cells
 * the program considers already correct are never sent again. Replaying a
 * suffix of that byte stream onto a `reset()` screen therefore leaves those
 * cells blank forever, which is what issue #596's pixel measurement found.
 *
 * This script reproduces that shape:
 *
 * - a header, two borders and a hint row that **only frame 0 ever writes**
 *   ({@link DifferentialFrameScript.paintOnceRows}),
 * - a scroll region (`DECSTBM`) whose log lines are appended with a newline at
 *   the region's bottom row — non-idempotent, so applying a byte range twice
 *   scrolls twice and the cell grid says so,
 * - a status row and an input row rewritten every frame with `ESC[K` from the
 *   model's own column,
 * - `DECSET 2026` framing and a full-width Hangul log line, so synchronized
 *   update handling and wide-cell widths take part in the comparison.
 */

const HEADER_ROW = 1;
const LOG_TOP_ROW = 3;
const LOG_BOTTOM_ROW = 18;
/** Frame 0's log lines sit near the region bottom so later scrolls keep them. */
const INITIAL_LOG_ROW = 12;
const STATUS_ROW = 20;
const TOP_BORDER_ROW = 21;
const INPUT_ROW = 22;
const BOTTOM_BORDER_ROW = 23;
const HINT_ROW = 24;
const INPUT_COLUMN = 3;

const SPINNER = ["|", "/", "-", "\\"];
const TYPED = "generate the report";

/** Log lines frame 0 prints. No later frame addresses these cells. */
const INITIAL_LOG_LINES = [
  { prefix: "read", text: "terminal-output-attach-coordinator.ts" },
  { prefix: "read", text: "TerminalView.tsx" },
  { prefix: "plan", text: "복구 경로 점검" },
];

export interface DifferentialFrameScript {
  cols: number;
  rows: number;
  /** Frame 0 is the full paint; the rest are differential updates. */
  frames: string[];
  /**
   * Viewport rows (0-based) written by frame 0 and never again. These are the
   * cells a truncated replay can never bring back.
   */
  paintOnceRows: number[];
  /**
   * Text frame 0 puts on screen and no later frame rewrites. Checked by content
   * rather than by row, because the log lines scroll while staying unrepainted.
   */
  paintOnceText: string[];
}

export interface DifferentialFrameOptions {
  cols?: number;
  rows?: number;
  /** Number of differential frames after the initial paint. */
  updates?: number;
}

export function createDifferentialFrameScript(
  options: DifferentialFrameOptions = {},
): DifferentialFrameScript {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const updates = options.updates ?? 12;
  const frames: string[] = [initialPaint(cols)];
  for (let index = 1; index <= updates; index += 1) frames.push(updateFrame(index));
  return {
    cols,
    rows,
    frames,
    paintOnceRows: [HEADER_ROW - 1, TOP_BORDER_ROW - 1, BOTTOM_BORDER_ROW - 1, HINT_ROW - 1],
    paintOnceText: [
      "codex  session started",
      "ctrl+c quit",
      ...INITIAL_LOG_LINES.map((line) => line.text),
    ],
  };
}

function initialPaint(cols: number): string {
  const border = "─".repeat(Math.min(cols - 2, 60));
  return [
    "\x1b[?25l",
    "\x1b[2J\x1b[H",
    // Log area scrolls; the chrome around it does not.
    `\x1b[${LOG_TOP_ROW};${LOG_BOTTOM_ROW}r`,
    at(HEADER_ROW, 1) + "\x1b[1;36mcodex\x1b[0m  session started",
    ...INITIAL_LOG_LINES.map(
      (line, index) =>
        at(INITIAL_LOG_ROW + index, 3) + `\x1b[2m${line.prefix}\x1b[0m  ${line.text}`,
    ),
    at(STATUS_ROW, 1) + "\x1b[33m|\x1b[0m \x1b[2mworking\x1b[0m\x1b[K",
    at(TOP_BORDER_ROW, 2) + `\x1b[90m${border}\x1b[0m`,
    at(INPUT_ROW, INPUT_COLUMN) + "> \x1b[K",
    at(BOTTOM_BORDER_ROW, 2) + `\x1b[90m${border}\x1b[0m`,
    at(HINT_ROW, 2) + "\x1b[90mctrl+c quit\x1b[0m",
    at(INPUT_ROW, INPUT_COLUMN + 2),
    "\x1b[?25h",
  ].join("");
}

function updateFrame(index: number): string {
  const parts = ["\x1b[?2026h"];
  // Status row: rewritten from column 1, erased from the model's own column.
  parts.push(
    at(STATUS_ROW, 1) +
      `\x1b[33m${SPINNER[index % SPINNER.length]}\x1b[0m \x1b[2mworking ${index}s\x1b[0m\x1b[K`,
  );
  // Every third frame appends a log line by scrolling the region — the newline
  // at the bottom row is what makes a double-applied range visible.
  if (index % 3 === 0) {
    parts.push(at(LOG_BOTTOM_ROW, 1) + "\n" + `  \x1b[32mok\x1b[0m  step ${index} 완료\x1b[K`);
  }
  // Input row: the typed prefix grows one character at a time.
  const typed = TYPED.slice(0, Math.min(index, TYPED.length));
  parts.push(at(INPUT_ROW, INPUT_COLUMN) + `> ${typed}\x1b[K`);
  parts.push(at(INPUT_ROW, INPUT_COLUMN + 2 + typed.length));
  parts.push("\x1b[?2026l");
  return parts.join("");
}

function at(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}
