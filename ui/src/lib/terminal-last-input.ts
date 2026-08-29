const MAX_DIRECT_INPUT_CHARS = 16 * 1024;
const CSI_SEQUENCE_PATTERN = /^\x1b\[([0-?]*)([ -/]*)([@-~])/u;
const LEGACY_MOUSE_PAYLOAD_CHARS = 3;

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
  };

  return {
    push(data: string) {
      const submitted: string[] = [];
      for (let index = 0; index < data.length; ) {
        const rest = data.slice(index);
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

          // xterm's DEFAULT mouse encoding is the legacy `CSI M Pb Px Py`
          // form. The three payload characters are not part of CSI grammar,
          // so consume them explicitly instead of recording coordinates as
          // typed text. SGR/SGR-pixels and URXVT reports are already consumed
          // as one CSI.
          if (!params && !intermediates && final === "M") {
            for (
              let payload = 0;
              payload < LEGACY_MOUSE_PAYLOAD_CHARS && index < data.length;
              payload += 1
            ) {
              const payloadCodePoint = data.codePointAt(index);
              if (payloadCodePoint === undefined) break;
              index += String.fromCodePoint(payloadCodePoint).length;
            }
            continue;
          }

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

        const codePoint = data.codePointAt(index);
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
