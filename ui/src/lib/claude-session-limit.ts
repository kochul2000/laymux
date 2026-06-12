import { stripAnsi } from "./activity-detection";

/**
 * Claude Code session-limit banner detection + reset-time math (issue #312).
 *
 * Claude Code prints a banner like:
 *
 *   ⎿  You've hit your session limit · resets 1:50pm (Asia/Seoul)
 *
 * into the scrollback when the rolling session window is exhausted. This
 * module is pure (no side effects): it only parses the banner out of a
 * rolling output window and computes the UTC instant at which an automatic
 * resume message should be sent. The caller (`TerminalView`) owns the timer,
 * dedupe state, and the actual PTY write.
 */
export interface ClaudeSessionLimitDetection {
  /** Reset hour in 24h form (0-23). */
  hour: number;
  /** Reset minute (0-59). */
  minute: number;
  /** IANA timezone from the banner, e.g. "Asia/Seoul". Undefined → local. */
  timeZone?: string;
  /** Stable dedupe key, e.g. "13:50|Asia/Seoul". */
  key: string;
}

/**
 * Matches the session/usage limit banner followed (within a short window —
 * the two fragments can be split across redraw rows) by the reset time.
 * Accepts straight and curly apostrophes, optional minutes (`7pm`), and an
 * optional `(IANA/Zone)` suffix. Global flag so the caller can walk every
 * occurrence and keep the freshest one.
 */
const SESSION_LIMIT_PATTERN =
  /You[’']ve hit your (?:session|usage) limit[\s\S]{0,160}?resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)\n]{1,64})\))?/gi;

/**
 * A reset time that passed less than this long ago is still treated as
 * "today's reset" instead of rolling over to tomorrow. Covers the case where
 * the banner is detected (or re-scanned) shortly after the reset instant —
 * without the grace, a banner seen at 1:50:30pm for "resets 1:50pm" would
 * schedule the resume for tomorrow.
 */
const RECENT_PAST_GRACE_MS = 10 * 60 * 1000;

/**
 * Extracts the latest session-limit banner from a rolling output window, or
 * `undefined` when none is present. Runs on ANSI-stripped text so colour and
 * cursor escapes inside the banner do not break the match.
 */
export function detectClaudeSessionLimitFromOutput(
  text: string,
): ClaudeSessionLimitDetection | undefined {
  const plain = stripAnsi(text);
  SESSION_LIMIT_PATTERN.lastIndex = 0;
  let last: ClaudeSessionLimitDetection | undefined;
  for (
    let match = SESSION_LIMIT_PATTERN.exec(plain);
    match;
    match = SESSION_LIMIT_PATTERN.exec(plain)
  ) {
    const hour12 = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const isPm = match[3].toLowerCase() === "pm";
    if (hour12 < 1 || hour12 > 12 || minute > 59) continue;
    const hour = (hour12 % 12) + (isPm ? 12 : 0);
    const timeZone = match[4]?.trim() || undefined;
    last = {
      hour,
      minute,
      timeZone,
      key: `${hour}:${String(minute).padStart(2, "0")}|${timeZone ?? "local"}`,
    };
  }
  return last;
}

/** Returns true when `tz` is a timezone identifier Intl can resolve. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` relative to UTC at the given instant. */
function tzOffsetMs(tz: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  // hour12:false can yield "24" at midnight in some engines — normalize to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - atMs;
}

/**
 * Converts a wall-clock datetime in `tz` to a UTC epoch (ms). Two fixed-point
 * iterations converge across DST transitions.
 */
function zonedTimeToUtcMs(
  tz: string,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    guess = wall - tzOffsetMs(tz, guess);
  }
  return guess;
}

/** Next instant (UTC epoch ms) at which the banner's reset time occurs. */
function nextResetInstantMs(detection: ClaudeSessionLimitDetection, nowMs: number): number {
  const tz =
    detection.timeZone && isValidTimeZone(detection.timeZone) ? detection.timeZone : undefined;

  if (tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    let candidate = zonedTimeToUtcMs(
      tz,
      get("year"),
      get("month") - 1,
      get("day"),
      detection.hour,
      detection.minute,
    );
    if (candidate <= nowMs - RECENT_PAST_GRACE_MS) {
      candidate = zonedTimeToUtcMs(
        tz,
        get("year"),
        get("month") - 1,
        get("day") + 1, // Date.UTC normalizes month/year overflow
        detection.hour,
        detection.minute,
      );
    }
    return candidate;
  }

  const candidate = new Date(nowMs);
  candidate.setHours(detection.hour, detection.minute, 0, 0);
  if (candidate.getTime() <= nowMs - RECENT_PAST_GRACE_MS) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

/**
 * UTC instant (epoch ms) at which the resume message should be written:
 * next occurrence of the banner's reset time plus `delaySeconds`, clamped to
 * never land in the past (a reset that just elapsed resumes immediately).
 */
export function computeSessionLimitResumeAt(
  detection: ClaudeSessionLimitDetection,
  nowMs: number,
  delaySeconds: number,
): number {
  const resetAt = nextResetInstantMs(detection, nowMs);
  return Math.max(resetAt + delaySeconds * 1000, nowMs);
}
