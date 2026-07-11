const encoder = new TextEncoder();

const REPAINT_START = encoder.encode("\x1b[?25l\x1b[H");
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

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/**
 * Drops the screen repaint ConPTY emits immediately after a width increase.
 * xterm has already reflowed its scrollback at that point, so replaying the
 * old screen at row 1 would overwrite historical rows that moved on screen.
 */
export class ConptyResizeRepaintFilter {
  private armedUntil = 0;
  private dropping = false;
  private expectedRepaints = 0;
  private startProbe = new Uint8Array();
  private endProbe = new Uint8Array();

  constructor(private readonly windowMs: number) {}

  get isArmed(): boolean {
    return this.expectedRepaints > 0;
  }

  get isDropping(): boolean {
    return this.dropping;
  }

  get expiresAt(): number {
    return this.armedUntil;
  }

  arm(now = Date.now()): void {
    if (!this.isArmed) {
      this.expectedRepaints = 1;
      this.startScanning(now);
      return;
    }

    this.expectedRepaints += 1;
    if (!this.dropping) {
      // Keep a split start marker private while extending the scan for the
      // newly requested resize. Resetting here lets xterm reconstruct the
      // marker across writes and bypass the filter.
      this.armedUntil = now + this.windowMs;
    }
  }

  /** Cancel one resize expectation without disturbing another outstanding frame. */
  cancelArm(): Uint8Array {
    if (!this.isArmed) return new Uint8Array();
    if (this.expectedRepaints > 1) {
      this.expectedRepaints -= 1;
      return new Uint8Array();
    }
    // Once a frame has started, finish dropping it even if the resize call
    // reports an error; releasing its suffix would corrupt the buffer.
    return this.dropping ? new Uint8Array() : this.flush();
  }

  private startScanning(now: number): void {
    this.armedUntil = now + this.windowMs;
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
    if (this.expectedRepaints > 1) {
      this.expectedRepaints -= 1;
      if (this.dropping) {
        this.startScanning(now);
      } else {
        // A partial marker may belong to the next outstanding repaint. Keep
        // it buffered instead of exposing it to xterm between scan windows.
        this.armedUntil = now + this.windowMs;
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
    this.expectedRepaints = 0;
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
    const start = indexOfBytes(candidate, REPAINT_START);
    if (start < 0) {
      const probeLength = matchingPrefixSuffixLength(candidate, REPAINT_START);
      this.startProbe = candidate.slice(candidate.length - probeLength);
      return candidate.slice(0, candidate.length - probeLength);
    }

    this.dropping = true;
    // The scan window limits when a repaint may start. Once recognized, give
    // the split frame its own bounded window in which to reach the end marker.
    this.armedUntil = now + this.windowMs;
    const prefix = candidate.slice(0, start);
    const suffix = this.dropUntilRepaintEnd(candidate.slice(start + REPAINT_START.length), now);
    return concatBytes(prefix, suffix);
  }

  private dropUntilRepaintEnd(data: Uint8Array, now: number): Uint8Array {
    const candidate = concatBytes(this.endProbe, data);
    const end = indexOfBytes(candidate, REPAINT_END);
    if (end >= 0) {
      const suffix = candidate.slice(end + REPAINT_END.length);
      this.expectedRepaints = Math.max(0, this.expectedRepaints - 1);
      if (this.expectedRepaints > 0) {
        this.startScanning(now);
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
