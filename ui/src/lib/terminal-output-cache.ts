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
