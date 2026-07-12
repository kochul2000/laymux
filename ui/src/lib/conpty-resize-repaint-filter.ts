const encoder = new TextEncoder();

const CURSOR_HIDE = encoder.encode("\x1b[?25l");
const CURSOR_HOME = encoder.encode("\x1b[H");
const WINDOW_SIZE_PREFIX = encoder.encode("\x1b[8;");
const REPAINT_END = encoder.encode("\x1b[?25h");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const lastStart = haystack.length - needle.length;
  for (let i = from; i <= lastStart; i++) {
    let matches = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function matchingPrefixSuffixLength(haystack: Uint8Array, needle: Uint8Array): number {
  const maxLength = Math.min(haystack.length, needle.length - 1);
  for (let length = maxLength; length > 0; length--) {
    const offset = haystack.length - length;
    let matches = true;
    for (let i = 0; i < length; i++) {
      if (haystack[offset + i] !== needle[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

type PrefixStatus = "full" | "partial" | "mismatch";

function prefixStatusAt(haystack: Uint8Array, needle: Uint8Array, offset: number): PrefixStatus {
  const available = haystack.length - offset;
  const compared = Math.min(available, needle.length);
  for (let index = 0; index < compared; index++) {
    if (haystack[offset + index] !== needle[index]) return "mismatch";
  }
  return available >= needle.length ? "full" : "partial";
}

function isAsciiDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}

type RepaintStartSearch =
  | { kind: "match"; start: number; end: number }
  | { kind: "partial"; start: number }
  | { kind: "none" };

/**
 * ConPTY sometimes inserts CSI 8;<rows>;<cols>t between cursor-hide and
 * cursor-home while shrinking. Keep the whole candidate private until that
 * optional sequence is either complete or disproven.
 */
function findRepaintStart(data: Uint8Array): RepaintStartSearch {
  let searchFrom = 0;
  while (searchFrom < data.length) {
    const start = indexOfBytes(data, CURSOR_HIDE, searchFrom);
    if (start < 0) break;
    let cursor = start + CURSOR_HIDE.length;

    const directHome = prefixStatusAt(data, CURSOR_HOME, cursor);
    if (directHome === "full") {
      return { kind: "match", start, end: cursor + CURSOR_HOME.length };
    }
    if (directHome === "partial") return { kind: "partial", start };

    const windowPrefix = prefixStatusAt(data, WINDOW_SIZE_PREFIX, cursor);
    if (windowPrefix === "partial") return { kind: "partial", start };
    if (windowPrefix === "full") {
      cursor += WINDOW_SIZE_PREFIX.length;

      const rowsStart = cursor;
      while (cursor < data.length && isAsciiDigit(data[cursor])) cursor++;
      if (cursor === data.length) return { kind: "partial", start };
      if (cursor > rowsStart && data[cursor] === 0x3b) {
        cursor++;
        const colsStart = cursor;
        while (cursor < data.length && isAsciiDigit(data[cursor])) cursor++;
        if (cursor === data.length) return { kind: "partial", start };
        if (cursor > colsStart && data[cursor] === 0x74) {
          cursor++;
          const home = prefixStatusAt(data, CURSOR_HOME, cursor);
          if (home === "full") {
            return { kind: "match", start, end: cursor + CURSOR_HOME.length };
          }
          if (home === "partial") return { kind: "partial", start };
        }
      }
    }

    searchFrom = start + 1;
  }

  const partialLength = matchingPrefixSuffixLength(data, CURSOR_HIDE);
  return partialLength > 0
    ? { kind: "partial", start: data.length - partialLength }
    : { kind: "none" };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/**
 * Drops the screen repaint ConPTY emits immediately after a width change.
 * xterm has already reflowed its scrollback at that point, so replaying the
 * old screen at row 1 would overwrite historical rows that moved on screen.
 */
export class ConptyResizeRepaintFilter {
  private armedUntil = 0;
  private dropping = false;
  private nextArmToken = 1;
  private arms: Array<{ token: number; deadline: number }> = [];
  private startProbe = new Uint8Array();
  private endProbe = new Uint8Array();

  constructor(private readonly windowMs: number) {}

  get isArmed(): boolean {
    return this.arms.length > 0;
  }

  get isDropping(): boolean {
    return this.dropping;
  }

  get expiresAt(): number {
    return this.armedUntil;
  }

  arm(now = Date.now()): number {
    const arm = { token: this.nextArmToken++, deadline: now + this.windowMs };
    this.arms.push(arm);
    if (this.arms.length === 1) this.startScanningUntil(arm.deadline);
    return arm.token;
  }

  /** Cancel one resize expectation without disturbing another outstanding frame. */
  cancelArm(token: number): Uint8Array {
    const index = this.arms.findIndex((arm) => arm.token === token);
    if (index < 0) return new Uint8Array();
    // Once a frame has started, finish dropping it even if the resize call
    // reports an error; releasing its suffix would corrupt the buffer.
    if (index === 0 && this.dropping) return new Uint8Array();

    this.arms.splice(index, 1);
    if (this.arms.length === 0) {
      const pending = this.startProbe;
      this.reset();
      return pending;
    }
    if (index === 0) {
      // The next arm keeps its own deadline. Preserve a split start probe so
      // xterm never sees half a marker between resize attempts.
      this.armedUntil = this.arms[0].deadline;
      this.endProbe = new Uint8Array();
    }
    return new Uint8Array();
  }

  private startScanningUntil(deadline: number): void {
    this.armedUntil = deadline;
    this.dropping = false;
    this.startProbe = new Uint8Array();
    this.endProbe = new Uint8Array();
  }

  disarm(): void {
    this.reset();
  }

  /** Expire one outstanding repaint and release a probe after the final one. */
  flush(now = Date.now()): Uint8Array {
    if (!this.isArmed) return new Uint8Array();
    if (this.arms.length > 1) {
      const wasDropping = this.dropping;
      this.arms.shift();
      if (wasDropping) {
        // The next frame could not be inspected until the incomplete current
        // frame was discarded, so give it a fresh bounded scan window.
        this.startScanningUntil(Math.max(this.arms[0].deadline, now + this.windowMs));
      } else {
        // A partial marker may belong to the next outstanding repaint. Keep
        // it buffered instead of exposing it to xterm between scan windows.
        this.armedUntil = this.arms[0].deadline;
        this.endProbe = new Uint8Array();
      }
      return new Uint8Array();
    }

    const pending = this.dropping ? new Uint8Array() : this.startProbe;
    this.reset();
    return pending;
  }

  private reset(): void {
    this.armedUntil = 0;
    this.dropping = false;
    this.arms = [];
    this.startProbe = new Uint8Array();
    this.endProbe = new Uint8Array();
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (!this.isArmed) return data;
    if (now > this.armedUntil) {
      const pending = this.flush(now);
      return this.isArmed
        ? concatBytes(pending, this.filter(data, now))
        : concatBytes(pending, data);
    }

    if (this.dropping) {
      return this.dropUntilRepaintEnd(data, now);
    }

    const candidate = concatBytes(this.startProbe, data);
    this.startProbe = new Uint8Array();
    const start = findRepaintStart(candidate);
    if (start.kind !== "match") {
      const probeStart = start.kind === "partial" ? start.start : candidate.length;
      this.startProbe = candidate.slice(probeStart);
      return candidate.slice(0, probeStart);
    }

    this.dropping = true;
    // The scan window limits when a repaint may start. Once recognized, give
    // the split frame its own bounded window in which to reach the end marker.
    this.armedUntil = now + this.windowMs;
    const prefix = candidate.slice(0, start.start);
    const suffix = this.dropUntilRepaintEnd(candidate.slice(start.end), now);
    return concatBytes(prefix, suffix);
  }

  private dropUntilRepaintEnd(data: Uint8Array, now: number): Uint8Array {
    const candidate = concatBytes(this.endProbe, data);
    const end = indexOfBytes(candidate, REPAINT_END);
    if (end >= 0) {
      const suffix = candidate.slice(end + REPAINT_END.length);
      this.arms.shift();
      if (this.arms.length > 0) {
        this.startScanningUntil(Math.max(this.arms[0].deadline, now + this.windowMs));
        return this.filter(suffix, now);
      }
      this.reset();
      return suffix;
    }

    const probeLength = Math.min(REPAINT_END.length - 1, candidate.length);
    this.endProbe = candidate.slice(candidate.length - probeLength);
    return new Uint8Array();
  }
}
