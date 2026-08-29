const MAX_DIRECT_INPUT_CHARS = 16 * 1024;
const MAX_PENDING_CSI_CHARS = 256;
const CSI_SEQUENCE_PATTERN = /^\x1b\[([0-?]*)([ -/]*)([@-~])/u;

function isIncompleteCsiSequence(value: string): boolean {
  return value === "\u001b" || /^\x1b\[[0-?]*[ -/]*$/u.test(value);
}

function shouldContinuePendingCsi(pending: string, next: string): boolean {
  if (!next) return true;
  if (pending === "\u001b") return next.startsWith("[");
  if (pending === "\u001b[") {
    const first = next.charCodeAt(0);
    // A parameter or intermediate byte proves that this is continuing CSI.
    // A bare final byte may instead be ordinary input after a standalone Esc/`[`.
    return first >= 0x20 && first <= 0x3f;
  }
  const combined = pending + next;
  return CSI_SEQUENCE_PATTERN.test(combined) || isIncompleteCsiSequence(combined);
}

export function normalizeSubmittedInput(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export interface TerminalLastInputSource {
  lastCommand?: string;
  lastCommandAt?: number;
  lastUserInput?: string;
  lastUserInputAt?: number;
}

export interface SelectedTerminalLastInput {
  text: string;
  timestamp: number;
}

export function selectTerminalLastInputEntry(
  value: TerminalLastInputSource,
): SelectedTerminalLastInput | undefined {
  const command = normalizeSubmittedInput(value.lastCommand ?? "");
  const userInput = normalizeSubmittedInput(value.lastUserInput ?? "");
  if (!userInput) {
    return command ? { text: command, timestamp: value.lastCommandAt ?? 0 } : undefined;
  }
  if (!command) return { text: userInput, timestamp: value.lastUserInputAt ?? 0 };
  return (value.lastUserInputAt ?? 0) >= (value.lastCommandAt ?? 0)
    ? { text: userInput, timestamp: value.lastUserInputAt ?? 0 }
    : { text: command, timestamp: value.lastCommandAt ?? 0 };
}

export function selectTerminalLastInput(value: TerminalLastInputSource): string | undefined {
  return selectTerminalLastInputEntry(value)?.text;
}

export function selectLatestTerminalInput(
  values: Iterable<TerminalLastInputSource>,
): SelectedTerminalLastInput | undefined {
  let latest: SelectedTerminalLastInput | undefined;
  for (const value of values) {
    const candidate = selectTerminalLastInputEntry(value);
    if (candidate && (!latest || candidate.timestamp > latest.timestamp)) latest = candidate;
  }
  return latest;
}

export interface DirectInputCapture {
  push(data: string): string[];
  reset(): void;
}

/**
 * Reconstruct completed lines from xterm's human `onData` stream.
 *
 * This is intentionally an input-side model: PTY output redraws never enter it.
 * It handles the common line-editor controls while keeping an explicit bound;
 * uncommon escape sequences are ignored instead of leaking control bytes into
 * the selector label.
 */
export function createDirectInputCapture(): DirectInputCapture {
  let value = "";
  let cursor = 0;
  let pendingCsi = "";

  const insert = (text: string) => {
    value = value.slice(0, cursor) + text + value.slice(cursor);
    cursor += text.length;
    if (value.length > MAX_DIRECT_INPUT_CHARS) {
      const overflow = value.length - MAX_DIRECT_INPUT_CHARS;
      value = value.slice(overflow);
      cursor = Math.max(0, cursor - overflow);
    }
  };

  const reset = () => {
    value = "";
    cursor = 0;
    pendingCsi = "";
  };

  return {
    push(data: string) {
      let input = data;
      if (pendingCsi) {
        if (!input) return [];
        const pending = pendingCsi;
        pendingCsi = "";
        if (shouldContinuePendingCsi(pending, input)) input = pending + input;
      }

      const submitted: string[] = [];
      for (let index = 0; index < input.length; ) {
        const rest = input.slice(index);
        // ECMA-48 CSI uses parameter bytes 0x30..0x3f, optional intermediate
        // bytes 0x20..0x2f, and a final byte 0x40..0x7e. In particular, SGR
        // mouse reports start their parameters with `<`; treating `<` as text
        // leaked reports such as `[<35;118;41M` into the selector label.
        const csi = rest.match(CSI_SEQUENCE_PATTERN);
        if (csi) {
          const params = csi[1];
          const intermediates = csi[2];
          const final = csi[3];
          index += csi[0].length;

          const amount = Math.max(1, Number.parseInt(params, 10) || 1);
          if (!intermediates) {
            if (final === "D") cursor = Math.max(0, cursor - amount);
            else if (final === "C") cursor = Math.min(value.length, cursor + amount);
            else if (final === "H" || (final === "~" && params === "1")) cursor = 0;
            else if (final === "F" || (final === "~" && params === "4")) cursor = value.length;
            else if (final === "~" && params === "3" && cursor < value.length) {
              value = value.slice(0, cursor) + value.slice(cursor + 1);
            }
          }
          continue;
        }

        if (isIncompleteCsiSequence(rest)) {
          // xterm normally emits a complete user-control report at once, but
          // callers of this stream model may split chunks. Keep only a small
          // syntactically valid prefix; an overlong malformed prefix is dropped.
          if (rest.length <= MAX_PENDING_CSI_CHARS) pendingCsi = rest;
          break;
        }

        const codePoint = input.codePointAt(index);
        if (codePoint === undefined) break;
        const char = String.fromCodePoint(codePoint);
        index += char.length;

        if (char === "\r" || char === "\n") {
          const normalized = normalizeSubmittedInput(value);
          if (normalized) submitted.push(normalized);
          reset();
        } else if (char === "\b" || char === "\u007f") {
          if (cursor > 0) {
            value = value.slice(0, cursor - 1) + value.slice(cursor);
            cursor -= 1;
          }
        } else if (char === "\u0001") {
          cursor = 0;
        } else if (char === "\u0005") {
          cursor = value.length;
        } else if (char === "\u0003") {
          reset();
        } else if (char === "\u0004") {
          if (cursor < value.length) value = value.slice(0, cursor) + value.slice(cursor + 1);
        } else if (char === "\u0015") {
          value = value.slice(cursor);
          cursor = 0;
        } else if (char === "\u0017") {
          const before = value.slice(0, cursor).replace(/\S+\s*$/u, "");
          value = before + value.slice(cursor);
          cursor = before.length;
        } else if (char === "\t") {
          insert(" ");
        } else if (codePoint >= 0x20 && codePoint !== 0x7f && char !== "\u001b") {
          insert(char);
        }
      }
      return submitted;
    },
    reset,
  };
}
