/**
 * Pace: how far through a billing window we are, versus how much of the quota
 * has been used.
 *
 * The backend carries reset times verbatim (`7pm (Asia/Seoul)`,
 * `Mar 6, 12pm (Asia/Seoul)`) and never interprets them. Turning one into an
 * elapsed fraction needs local-calendar reasoning, so that lives here — one
 * implementation, on the side that already has a calendar (ADR-0102).
 */

/** Length of a Claude session window. */
export const SESSION_WINDOW_HOURS = 5;
/** Length of a weekly window. */
export const WEEK_WINDOW_DAYS = 7;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `7pm`, `11:59am` — hour, optional minute, meridiem. */
const TIME_ONLY = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
/** `Mar 6, 11:59am` — month name, day, then the same time shape. */
const DATE_TIME = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

function to24Hour(hour: number, meridiem: string): number {
  const lower = meridiem.toLowerCase();
  if (lower === "pm") return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

/**
 * Resolve a reset string to the next instant it names.
 *
 * Time-only strings roll forward to the next occurrence. Dated strings assume
 * the current year, rolling to next year only when the result would be more than
 * one window in the past — a Dec/Jan boundary otherwise reads as 11 months ago.
 */
export function resolveResetInstant(
  reset: string,
  windowMs: number,
  now: Date = new Date(),
): Date | null {
  const trimmed = reset.trim();

  const dated = DATE_TIME.exec(trimmed);
  if (dated) {
    const monthIndex = MONTHS.indexOf(dated[1].slice(0, 3).toLowerCase());
    if (monthIndex < 0) return null;
    const day = Number(dated[2]);
    const hour = to24Hour(Number(dated[3]), dated[5]);
    const minute = dated[4] ? Number(dated[4]) : 0;
    const candidate = new Date(now.getFullYear(), monthIndex, day, hour, minute, 0, 0);
    if (candidate.getTime() < now.getTime() - windowMs) {
      candidate.setFullYear(now.getFullYear() + 1);
    }
    return candidate;
  }

  const timed = TIME_ONLY.exec(trimmed);
  if (!timed) return null;
  const hour = to24Hour(Number(timed[1]), timed[3]);
  const minute = timed[2] ? Number(timed[2]) : 0;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Percentage of a window that has elapsed, or `null` when the reset text could
 * not be read.
 *
 * A window is defined backwards from its reset instant, which is the only anchor
 * Claude Code gives us.
 */
export function elapsedPercent(
  reset: string | null | undefined,
  windowMs: number,
  now: Date = new Date(),
): number | null {
  if (!reset) return null;
  const resetAt = resolveResetInstant(reset, windowMs, now);
  if (!resetAt) return null;
  const startedAt = resetAt.getTime() - windowMs;
  const elapsed = ((now.getTime() - startedAt) / windowMs) * 100;
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, Math.min(100, Math.round(elapsed)));
}

export const SESSION_WINDOW_MS = SESSION_WINDOW_HOURS * 60 * 60 * 1000;
export const WEEK_WINDOW_MS = WEEK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Elapsed percentage of the 5-hour session window. */
export function sessionElapsedPercent(
  reset: string | null | undefined,
  now: Date = new Date(),
): number | null {
  return elapsedPercent(reset, SESSION_WINDOW_MS, now);
}

/** Elapsed percentage of the 7-day weekly window. */
export function weekElapsedPercent(
  reset: string | null | undefined,
  now: Date = new Date(),
): number | null {
  return elapsedPercent(reset, WEEK_WINDOW_MS, now);
}

/** How usage compares to elapsed time. */
export type PaceVerdict = "ahead" | "onTrack" | "behind" | "unknown";

/** Percentage points of slack before usage counts as running hot. */
export const PACE_TOLERANCE_POINTS = 5;

/**
 * Compare quota used against window elapsed.
 *
 * `ahead` means burning faster than the clock — the state worth warning about.
 * `behind` means under-using. Both need both numbers, so a missing one is
 * `unknown` rather than an optimistic default.
 */
export function paceVerdict(
  usedPercent: number | null | undefined,
  elapsed: number | null | undefined,
): PaceVerdict {
  if (usedPercent == null || elapsed == null) return "unknown";
  const delta = usedPercent - elapsed;
  if (delta > PACE_TOLERANCE_POINTS) return "ahead";
  if (delta < -PACE_TOLERANCE_POINTS) return "behind";
  return "onTrack";
}

/** Human-readable time remaining until a reset, e.g. `2h 14m`. */
export function formatTimeUntil(
  reset: string | null | undefined,
  windowMs: number,
  now: Date = new Date(),
): string | null {
  if (!reset) return null;
  const resetAt = resolveResetInstant(reset, windowMs, now);
  if (!resetAt) return null;
  const remainingMs = resetAt.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
