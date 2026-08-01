/**
 * Minimal SGR-aware ANSI parser for the log preview.
 *
 * `activity-detection.ts` already strips ANSI, but it is deliberately lossy: it
 * rewrites CUP into newlines and CUF into spaces so a Claude modal can be
 * matched by shape, and it throws colors away entirely. The log viewer needs the
 * opposite trade-off — exact text plus the colors — so this is a separate parser
 * rather than a reuse of that one.
 */

export interface AnsiStyle {
  /** CSS color string; absent means "use the default foreground". */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface AnsiSpan extends AnsiStyle {
  text: string;
}

export interface AnsiParser {
  /** Parse one line, carrying SGR state across calls the way a terminal does. */
  parseLine(line: string): AnsiSpan[];
}

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const ESC = "\x1b";

/**
 * Catppuccin Mocha's terminal palette, so log colors match the rest of the app
 * (`ui/src/index.css` `:root`). Indices 0-7 are the normal colors, 8-15 the
 * bright ones; Mocha only brightens black and white, the six hues are shared.
 */
const ANSI_PALETTE = [
  "#45475a", // black   (surface1)
  "#f38ba8", // red
  "#a6e3a1", // green
  "#f9e2af", // yellow
  "#89b4fa", // blue
  "#f5c2e7", // magenta (pink)
  "#94e2d5", // cyan    (teal)
  "#bac2de", // white   (subtext1)
  "#585b70", // bright black (surface2)
  "#f38ba8",
  "#a6e3a1",
  "#f9e2af",
  "#89b4fa",
  "#f5c2e7",
  "#94e2d5",
  "#a6adc8", // bright white (subtext0)
] as const;

/** Substituted for the missing side when `inverse` swaps an unset color. */
const DEFAULT_FG = "#cdd6f4";
const DEFAULT_BG = "#1e1e2e";

/**
 * A CSI/OSC/charset introducer. A bare `\x1b` is not enough: real log text can
 * end mid-write, and treating that as "styled" would push a plain line down the
 * parser path for nothing.
 */
const ANSI_INTRODUCER = /\x1b[[\]()*+]/;

interface AnsiState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Kept out of the emitted span: it swaps colors at emit time, see `emitStyle`. */
  inverse: boolean;
}

export function createAnsiParser(): AnsiParser {
  const state = freshState();

  return {
    parseLine(line: string): AnsiSpan[] {
      const spans: AnsiSpan[] = [];
      let text = "";
      let i = 0;

      const flush = () => {
        if (text.length === 0) return;
        pushSpan(spans, emitStyle(state), text);
        text = "";
      };

      while (i < line.length) {
        if (line[i] !== ESC) {
          text += line[i];
          i += 1;
          continue;
        }

        const next = line[i + 1];

        // Lone trailing escape: a truncated write, nothing to consume.
        if (next === undefined) break;

        if (next === "[") {
          // CSI = params (0x30-0x3f), intermediates (0x20-0x2f), final (0x40-0x7e).
          let j = i + 2;
          while (j < line.length && isInRange(line, j, 0x30, 0x3f)) j += 1;
          const paramsEnd = j;
          while (j < line.length && isInRange(line, j, 0x20, 0x2f)) j += 1;
          if (j >= line.length) break; // unterminated CSI — drop the remainder
          if (line[j] === "m") {
            // Flush before mutating: the buffered text belongs to the old style.
            flush();
            applySgr(state, line.slice(i + 2, paramsEnd));
          }
          i = j + 1;
          continue;
        }

        if (next === "]") {
          // OSC runs until BEL or ST; an unterminated one swallows the rest.
          let j = i + 2;
          while (j < line.length) {
            if (line[j] === "\x07") {
              j += 1;
              break;
            }
            if (line[j] === ESC && line[j + 1] === "\\") {
              j += 2;
              break;
            }
            j += 1;
          }
          i = j;
          continue;
        }

        // Charset designators are three bytes (`\x1b(B`); every other two-byte
        // escape (`\x1bM`, `\x1b7`, ...) is dropped whole so its payload byte
        // never leaks into the text.
        i += next === "(" || next === ")" || next === "*" || next === "+" ? 3 : 2;
      }

      flush();
      return spans;
    },
  };
}

/** True when `text` contains a sequence this parser would consume. */
export function hasAnsiSequences(text: string): boolean {
  return ANSI_INTRODUCER.test(text);
}

/**
 * Severity keywords, highest first. The lookbehind rejects `/` and `-` so paths
 * (`/var/log/error/`) and flags (`--warn-only`) do not read as levels, and the
 * `\w` guards on both sides keep `TERROR` and `INFORMATION` out. Structured
 * forms (`level=error`, `"level":"error"`, `[ERROR]`) match for free because
 * `=`, `"` and `[` are all non-word characters.
 */
const LOG_LEVEL_PATTERNS: ReadonlyArray<readonly [LogLevel, RegExp]> = [
  ["error", buildLevelPattern("error|err|fatal|panic|critical")],
  ["warn", buildLevelPattern("warning|warn")],
  ["info", buildLevelPattern("info|notice")],
  ["debug", buildLevelPattern("debug")],
  ["trace", buildLevelPattern("trace")],
];

/** Long lines are usually payload dumps; only the prefix carries the level. */
const LOG_LEVEL_SCAN_LIMIT = 200;

export function detectLogLevel(line: string): LogLevel | null {
  const head = line.slice(0, LOG_LEVEL_SCAN_LIMIT);
  for (const [level, pattern] of LOG_LEVEL_PATTERNS) {
    if (pattern.test(head)) return level;
  }
  return null;
}

function buildLevelPattern(alternatives: string): RegExp {
  return new RegExp(`(?<![\\w/-])(?:${alternatives})(?![\\w])`, "i");
}

function freshState(): AnsiState {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

function isInRange(line: string, index: number, low: number, high: number): boolean {
  const code = line.charCodeAt(index);
  return code >= low && code <= high;
}

/**
 * Project the running state onto a span. `inverse` is resolved here rather than
 * stored swapped, so a later `27` restores the original pair unchanged.
 */
function emitStyle(state: AnsiState): AnsiStyle {
  const style: AnsiStyle = {};
  const fg = state.inverse ? (state.bg ?? DEFAULT_BG) : state.fg;
  const bg = state.inverse ? (state.fg ?? DEFAULT_FG) : state.bg;
  if (fg !== undefined) style.fg = fg;
  if (bg !== undefined) style.bg = bg;
  if (state.bold) style.bold = true;
  if (state.dim) style.dim = true;
  if (state.italic) style.italic = true;
  if (state.underline) style.underline = true;
  if (state.strike) style.strike = true;
  return style;
}

function pushSpan(spans: AnsiSpan[], style: AnsiStyle, text: string): void {
  const last = spans[spans.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  spans.push({ ...style, text });
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}

function applySgr(state: AnsiState, params: string): void {
  // `\x1b[m` and `\x1b[;m` both mean reset, so an empty slot is code 0.
  const codes = (params.length === 0 ? "0" : params)
    .split(";")
    .map((part) => (part.length === 0 ? 0 : Number.parseInt(part, 10)));

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (Number.isNaN(code)) continue;

    switch (code) {
      case 0:
        Object.assign(state, freshState());
        continue;
      case 1:
        state.bold = true;
        continue;
      case 2:
        state.dim = true;
        continue;
      case 3:
        state.italic = true;
        continue;
      case 4:
        state.underline = true;
        continue;
      case 7:
        state.inverse = true;
        continue;
      case 9:
        state.strike = true;
        continue;
      case 22:
        // One code clears both intensities — there is no "bold off" on its own.
        state.bold = false;
        state.dim = false;
        continue;
      case 23:
        state.italic = false;
        continue;
      case 24:
        state.underline = false;
        continue;
      case 27:
        state.inverse = false;
        continue;
      case 29:
        state.strike = false;
        continue;
      case 38:
      case 48: {
        const extended = readExtendedColor(codes, i);
        if (code === 38) state.fg = extended.color;
        else state.bg = extended.color;
        // Skip the sub-parameters so they are never read as standalone codes.
        i = extended.next;
        continue;
      }
      case 39:
        state.fg = undefined;
        continue;
      case 49:
        state.bg = undefined;
        continue;
      default:
        if (code >= 30 && code <= 37) state.fg = ANSI_PALETTE[code - 30];
        else if (code >= 40 && code <= 47) state.bg = ANSI_PALETTE[code - 40];
        else if (code >= 90 && code <= 97) state.fg = ANSI_PALETTE[code - 90 + 8];
        else if (code >= 100 && code <= 107) state.bg = ANSI_PALETTE[code - 100 + 8];
        // Anything else (53 overline, 5 blink, ...) is ignored, but the codes
        // after it still apply — a single unknown must not void the sequence.
        continue;
    }
  }
}

/**
 * Read `38;5;n` / `38;2;r;g;b` starting at the `38`/`48` slot. Returns the index
 * of the last consumed parameter so the caller can resume after it; an
 * unrecognized or truncated form yields no color and consumes only the selector.
 */
function readExtendedColor(
  codes: number[],
  start: number,
): { color: string | undefined; next: number } {
  const mode = codes[start + 1];
  if (mode === 5 && start + 2 < codes.length) {
    return { color: xterm256Color(codes[start + 2]), next: start + 2 };
  }
  if (mode === 2 && start + 4 < codes.length) {
    const [r, g, b] = [codes[start + 2], codes[start + 3], codes[start + 4]];
    return { color: rgbToHex(r, g, b), next: start + 4 };
  }
  return { color: undefined, next: mode === undefined ? start : start + 1 };
}

function xterm256Color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_PALETTE[index];
  if (index < 232) {
    // 6x6x6 cube: channel level is 0 for 0, otherwise 55 + 40 * v.
    const n = index - 16;
    return rgbToHex(
      cubeLevel(Math.floor(n / 36)),
      cubeLevel(Math.floor(n / 6) % 6),
      cubeLevel(n % 6),
    );
  }
  // 24-step grayscale ramp: 8, 18, ... 238.
  const gray = 8 + (index - 232) * 10;
  return rgbToHex(gray, gray, gray);
}

function cubeLevel(v: number): number {
  return v === 0 ? 0 : 55 + v * 40;
}

function rgbToHex(r: number, g: number, b: number): string | undefined {
  if (![r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) return undefined;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
