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
  private endProbe = new Uint8Array();

  constructor(private readonly windowMs: number) {}

  get isArmed(): boolean {
    return this.armedUntil !== 0;
  }

  arm(now = Date.now()): void {
    this.armedUntil = now + this.windowMs;
    this.dropping = false;
    this.endProbe = new Uint8Array();
  }

  disarm(): void {
    this.armedUntil = 0;
    this.dropping = false;
    this.endProbe = new Uint8Array();
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (!this.isArmed) return data;
    if (now > this.armedUntil) {
      this.disarm();
      return data;
    }

    if (this.dropping) {
      return this.dropUntilRepaintEnd(data);
    }

    const start = indexOfBytes(data, REPAINT_START);
    if (start < 0) return data;

    this.dropping = true;
    const prefix = data.slice(0, start);
    const suffix = this.dropUntilRepaintEnd(data.slice(start + REPAINT_START.length));
    return concatBytes(prefix, suffix);
  }

  private dropUntilRepaintEnd(data: Uint8Array): Uint8Array {
    const candidate = concatBytes(this.endProbe, data);
    const end = indexOfBytes(candidate, REPAINT_END);
    if (end >= 0) {
      const suffix = candidate.slice(end + REPAINT_END.length);
      this.disarm();
      return suffix;
    }

    const probeLength = Math.min(REPAINT_END.length - 1, candidate.length);
    this.endProbe = candidate.slice(candidate.length - probeLength);
    return new Uint8Array();
  }
}
