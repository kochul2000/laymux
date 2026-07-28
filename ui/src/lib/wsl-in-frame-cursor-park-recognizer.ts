const ESC = 0x1b;
const BEL = 0x07;
const MAX_CSI_BYTES = 256;

type ControlStringKind = "osc" | "st";
type LexicalState =
  | { kind: "normal" }
  | { kind: "escape"; bytes: number[]; startOffset: number }
  | { kind: "csi"; bytes: number[]; startOffset: number }
  | { kind: "control"; control: ControlStringKind; previousEsc: boolean };
type InFrameParkStage = "none" | "shown" | "positioned";
type CsiKind = "frameStart" | "frameEnd" | "cursorShow" | "position" | "other";

export interface WslCursorMetadataEmission {
  data: Uint8Array;
  stabilized: false;
  frameEndCursorAuthoritative?: true;
}

/**
 * Read-only recognizer for Codex's strict in-frame cursor park on WSL.
 *
 * WSL output must remain byte-for-byte pass-through: unlike the native Windows
 * stabilizer, this class never holds, removes, or reorders bytes. It only splits
 * the current chunk at an authoritative DEC 2026 reset so TerminalView can scope
 * the metadata to the exact xterm write that parses that reset.
 */
export class WslInFrameCursorParkRecognizer {
  private lexical: LexicalState = { kind: "normal" };
  private streamOffset = 0;
  private frameOpen = false;
  private inFrameParkStage: InFrameParkStage = "none";

  reset(): void {
    this.lexical = { kind: "normal" };
    this.streamOffset = 0;
    this.frameOpen = false;
    this.inFrameParkStage = "none";
  }

  push(data: Uint8Array): WslCursorMetadataEmission[] {
    const chunkStartOffset = this.streamOffset;
    const emissions: WslCursorMetadataEmission[] = [];
    let emissionStart = 0;

    for (let index = 0; index < data.length; index += 1) {
      const authoritativeTokenStart = this.consumeByte(data[index], chunkStartOffset + index);
      if (authoritativeTokenStart === undefined) continue;

      const tokenStart = Math.max(
        emissionStart,
        Math.max(0, authoritativeTokenStart - chunkStartOffset),
      );
      appendEmission(emissions, data.subarray(emissionStart, tokenStart), false);
      appendEmission(emissions, data.subarray(tokenStart, index + 1), true);
      emissionStart = index + 1;
    }

    appendEmission(emissions, data.subarray(emissionStart), false);
    this.streamOffset += data.length;
    return emissions;
  }

  private consumeByte(byte: number, offset: number): number | undefined {
    switch (this.lexical.kind) {
      case "normal":
        if (byte === ESC) {
          this.lexical = { kind: "escape", bytes: [byte], startOffset: offset };
        } else if (this.inFrameParkStage !== "none") {
          this.inFrameParkStage = "none";
        }
        return undefined;
      case "escape":
        return this.consumeEscapeByte(byte, offset);
      case "csi":
        return this.consumeCsiByte(byte);
      case "control": {
        const control = this.lexical;
        if (isControlStringEnd(control.control, control.previousEsc, byte)) {
          this.lexical = { kind: "normal" };
        } else {
          control.previousEsc = byte === ESC;
        }
        return undefined;
      }
    }
  }

  private consumeEscapeByte(byte: number, offset: number): number | undefined {
    const escape = this.lexical as Extract<LexicalState, { kind: "escape" }>;
    escape.bytes.push(byte);
    if (byte === 0x5b) {
      this.lexical = {
        kind: "csi",
        bytes: escape.bytes,
        startOffset: escape.startOffset,
      };
      return undefined;
    }

    const control = controlStringKind(byte);
    if (control) {
      this.inFrameParkStage = "none";
      this.lexical = { kind: "control", control, previousEsc: false };
      return undefined;
    }

    this.inFrameParkStage = "none";
    this.lexical =
      byte === ESC ? { kind: "escape", bytes: [byte], startOffset: offset } : { kind: "normal" };
    return undefined;
  }

  private consumeCsiByte(byte: number): number | undefined {
    const csi = this.lexical as Extract<LexicalState, { kind: "csi" }>;
    csi.bytes.push(byte);
    if (byte >= 0x40 && byte <= 0x7e) {
      this.lexical = { kind: "normal" };
      return this.completeCsi(csi.bytes, csi.startOffset);
    }

    const isParameterOrIntermediate = byte >= 0x20 && byte <= 0x3f;
    if (!isParameterOrIntermediate || csi.bytes.length > MAX_CSI_BYTES) {
      this.inFrameParkStage = "none";
      this.lexical = { kind: "normal" };
    }
    return undefined;
  }

  private completeCsi(bytes: readonly number[], tokenStartOffset: number): number | undefined {
    const kind = classifyCsi(bytes);
    if (kind === "frameStart") {
      this.frameOpen = true;
      this.inFrameParkStage = "none";
      return undefined;
    }
    if (!this.frameOpen) return undefined;

    if (kind === "cursorShow") {
      this.inFrameParkStage = "shown";
      return undefined;
    }
    if (
      kind === "position" &&
      (this.inFrameParkStage === "shown" || this.inFrameParkStage === "positioned")
    ) {
      this.inFrameParkStage = "positioned";
      return undefined;
    }
    if (kind === "frameEnd") {
      const authoritative = this.inFrameParkStage === "positioned";
      this.frameOpen = false;
      this.inFrameParkStage = "none";
      return authoritative ? tokenStartOffset : undefined;
    }

    if (this.inFrameParkStage !== "none") this.inFrameParkStage = "none";
    return undefined;
  }
}

function appendEmission(
  emissions: WslCursorMetadataEmission[],
  data: Uint8Array,
  frameEndCursorAuthoritative: boolean,
): void {
  if (data.length === 0) return;
  emissions.push({
    data,
    stabilized: false,
    ...(frameEndCursorAuthoritative ? { frameEndCursorAuthoritative: true as const } : {}),
  });
}

function controlStringKind(byte: number): ControlStringKind | undefined {
  if (byte === 0x5d) return "osc";
  if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) return "st";
  return undefined;
}

function isControlStringEnd(kind: ControlStringKind, previousEsc: boolean, byte: number): boolean {
  return (kind === "osc" && byte === BEL) || (previousEsc && byte === 0x5c);
}

function classifyCsi(bytes: readonly number[]): CsiKind {
  const text = String.fromCharCode(...bytes);
  if (text === "\x1b[?2026h") return "frameStart";
  if (text === "\x1b[?2026l") return "frameEnd";
  if (text === "\x1b[?25h") return "cursorShow";
  const body = text.slice(2, -1);
  const final = text.at(-1);
  if ((final === "H" || final === "f") && /^[0-9;]*$/.test(body)) return "position";
  if (final === "G" && /^\d*$/.test(body)) return "position";
  return "other";
}
