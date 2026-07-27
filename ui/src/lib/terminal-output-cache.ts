import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/xterm";

/**
 * SerializeAddon prefixes the active alternate buffer with this sequence and
 * intentionally leaves it active so replay reproduces the exact live screen.
 * A persisted output cache must instead reopen in the normal buffer, where
 * scrollback and the terminal scrollbar are available.
 */
const SERIALIZED_ALT_BUFFER_PREFIX = "\x1b[?1049h\x1b[H";

/** Persist scrollback only; a new PTY owns live terminal modes after restore. */
export const TERMINAL_OUTPUT_SERIALIZE_OPTIONS = {
  excludeAltBuffer: true,
  excludeModes: true,
} as const;

const SESSION_RESTORE_MARKER = "\r\n\x1b[90m--- session restored ---\x1b[0m\r\n";

/**
 * Put persisted output behind a fresh live-screen origin.
 *
 * The backend PTY owns a new `rows`-high screen and may address its cells with
 * CUP/HVP from row 1. Replaying cache without advancing the frontend screen
 * leaves xterm's cursor at the cache tail while those PTY writes still land at
 * the first row, splitting the visible prompt and typed input. One screen of
 * line feeds moves every restored viewport row into scrollback; CUP home then
 * aligns xterm row 1 with the PTY's row 1.
 */
export function terminalRestoreBoundary(rows: number): string {
  const screenRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  return `${SESSION_RESTORE_MARKER}${"\r\n".repeat(screenRows)}\x1b[H`;
}

/**
 * Serialize through the last meaningful normal-buffer row.
 *
 * `terminalRestoreBoundary` deliberately leaves blank rows below the live PTY
 * screen content. SerializeAddon's default scrollback path includes those rows
 * whenever `baseY > 0`, so persisting with the default options would add one
 * blank screen on every restart. An explicit range omits that runtime-only
 * tail and also omits final cursor repositioning, which the next live PTY owns.
 */
export function serializeTerminalOutput(
  terminal: Terminal,
  serializeAddon: SerializeAddon,
): string {
  const buffer = terminal.buffer.normal;
  let end = Math.min(buffer.length - 1, Math.max(0, buffer.baseY + buffer.cursorY));

  for (let index = buffer.length - 1; index > end; index -= 1) {
    if (buffer.getLine(index)?.translateToString(true)) {
      end = index;
      break;
    }
  }

  return serializeAddon.serialize({
    ...TERMINAL_OUTPUT_SERIALIZE_OPTIONS,
    range: { start: 0, end },
  });
}

/**
 * Return only the serialized normal buffer.
 *
 * This also repairs caches written by older versions while a TUI alternate
 * screen was active. SerializeAddon emits normal-buffer content first, then
 * the exact prefix above and the ephemeral alternate-buffer snapshot.
 */
export function normalBufferOnly(cached: string): string {
  const alternateBufferStart = cached.indexOf(SERIALIZED_ALT_BUFFER_PREFIX);
  return alternateBufferStart === -1 ? cached : cached.slice(0, alternateBufferStart);
}
