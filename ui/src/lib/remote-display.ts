export const REMOTE_FONT_SIZE_MIN = 8;
export const REMOTE_FONT_SIZE_MAX = 32;
export const DEFAULT_REMOTE_TERMINAL_FONT_SIZE = 14;
export const DEFAULT_REMOTE_COMPOSER_FONT_SIZE = 14;

export function normalizeRemoteFontSize(value: number): number {
  const finite = Number.isFinite(value) ? Math.round(value) : DEFAULT_REMOTE_TERMINAL_FONT_SIZE;
  return Math.max(REMOTE_FONT_SIZE_MIN, Math.min(REMOTE_FONT_SIZE_MAX, finite));
}
