/**
 * Mouse wheel scroll multipliers handed to xterm (`scrollSensitivity` /
 * `fastScrollSensitivity`).
 *
 * Mirrors the Rust bounds in `constants.rs` (`MIN/MAX_SCROLL_SENSITIVITY`), so a
 * hand-edited settings.json behaves the same whether it is clamped by the
 * backend or normalized here. xterm throws on a non-positive sensitivity, hence
 * the positive floor.
 */
export const SCROLL_SENSITIVITY_MIN = 0.1;
export const SCROLL_SENSITIVITY_MAX = 20;
export const SCROLL_SENSITIVITY_STEP = 0.1;
export const DEFAULT_SCROLL_SENSITIVITY = 1;
export const DEFAULT_FAST_SCROLL_SENSITIVITY = 5;

/** Clamp to the supported band, snapped to the 0.1 step the settings UI offers. */
export function normalizeScrollSensitivity(
  value: string | number,
  fallback: number = DEFAULT_SCROLL_SENSITIVITY,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const clamped = Math.min(SCROLL_SENSITIVITY_MAX, Math.max(SCROLL_SENSITIVITY_MIN, parsed));
  return Math.round(clamped * 10) / 10;
}
