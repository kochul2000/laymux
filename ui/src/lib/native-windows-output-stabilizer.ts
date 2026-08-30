const ESC = 0x1b;
const BEL = 0x07;
const DEFAULT_HOLD_MS = 50;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CSI_BYTES = 256;

type ControlStringKind = "osc" | "st";
type LexicalState =
  | { kind: "normal" }
  | { kind: "escape"; bytes: number[]; heldStart?: number; startedAt: number }
  | { kind: "csi"; bytes: number[]; heldStart?: number; startedAt: number }
  | { kind: "control"; control: ControlStringKind; previousEsc: boolean }
  | { kind: "passEscape" }
  | { kind: "passCsi"; bytesSeen: number }
  | { kind: "passControl"; control: ControlStringKind; previousEsc: boolean };

type TransactionPhase = "holdingFrame" | "awaitingRestore";
type RestoreStage = "hide" | "position" | "show";
type InFrameParkStage =
  | "none"
  | "positionsBeforeShow"
  | "shown"
  | "showThenPositioned"
  | "positionThenShown";

interface Transaction {
  phase: TransactionPhase;
  restoreStage: RestoreStage;
  bytes: number[];
  omitOnSuccess: Array<{ start: number; end: number }>;
  frameStartAt: number;
  deadline: number;
  frameEndAt?: number;
  inFrameParkStage: InFrameParkStage;
}

export interface StabilizedOutputEmission {
  data: Uint8Array;
  stabilized: boolean;
  parkDeadline?: number;
  /** The frame itself ended on the app's authoritative input-caret CUP. */
  frameEndCursorAuthoritative?: boolean;
}

export interface NativeWindowsOutputStabilizerOptions {
  holdMs?: number;
  maxBufferedBytes?: number;
}

/**
 * Surface-local byte stream stabilizer for native Windows synchronized-output
 * frames. It only recognizes the narrow DEC 2026 + DECTCEM park grammars
 * pinned by ADR-0076 (legacy out-of-frame restore and Codex 0.145 in-frame park),
 * plus ADR-0221's Codex 0.150+ position-first tail; every malformed, late, or
 * oversized candidate is emitted byte-for-byte.
 */
export class NativeWindowsOutputStabilizer {
  private readonly holdMs: number;
  private readonly maxBufferedBytes: number;
  private lexical: LexicalState = { kind: "normal" };
  private transaction: Transaction | undefined;

  constructor(options: NativeWindowsOutputStabilizerOptions = {}) {
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  get deadline(): number | undefined {
    return this.transaction?.deadline;
  }

  /** Bytes that have not been handed to xterm yet. */
  get hasHeldBytes(): boolean {
    return (
      this.transaction !== undefined ||
      this.lexical.kind === "escape" ||
      this.lexical.kind === "csi"
    );
  }

  /** A stream construct that must finish before xterm buffer reflow is safe. */
  get hasOpenSequence(): boolean {
    return this.transaction !== undefined || this.lexical.kind !== "normal";
  }

  reset(): void {
    this.lexical = { kind: "normal" };
    this.transaction = undefined;
  }

  push(data: Uint8Array, now: number): StabilizedOutputEmission[] {
    const output = new EmissionBuilder();
    this.expireIfNeeded(now, output);
    for (const byte of data) this.consumeByte(byte, now, output);
    return output.finish();
  }

  flushExpired(now: number): StabilizedOutputEmission[] {
    const output = new EmissionBuilder();
    this.expireIfNeeded(now, output);
    return output.finish();
  }

  private consumeByte(byte: number, now: number, output: EmissionBuilder): void {
    switch (this.lexical.kind) {
      case "normal":
        this.consumeNormalByte(byte, now, output);
        return;
      case "escape":
        this.consumeEscapeByte(byte, now, output);
        return;
      case "csi":
        this.consumeCsiByte(byte, now, output);
        return;
      case "control":
        this.consumeControlByte(byte, output);
        return;
      case "passEscape":
        this.consumePassEscapeByte(byte, now, output);
        return;
      case "passCsi":
        this.consumePassCsiByte(byte, now, output);
        return;
      case "passControl":
        output.append(byte);
        if (isControlStringEnd(this.lexical.control, this.lexical.previousEsc, byte)) {
          this.lexical = { kind: "normal" };
        } else {
          this.lexical.previousEsc = byte === ESC;
        }
        return;
    }
  }

  private consumeNormalByte(byte: number, now: number, output: EmissionBuilder): void {
    if (byte === ESC) {
      const heldStart = this.transaction?.bytes.length;
      if (!this.appendHeld(byte, output)) {
        // The ESC byte was already emitted by fail-open. Keep only its lexical
        // continuation so a split OSC/CSI introducer in the next chunk is not
        // reinterpreted as normal payload.
        this.lexical = { kind: "passEscape" };
        return;
      }
      this.lexical = {
        kind: "escape",
        bytes: [byte],
        startedAt: now,
        ...(heldStart === undefined ? {} : { heldStart }),
      };
      return;
    }

    if (this.transaction) {
      if (!this.appendHeld(byte, output)) return;
      if (this.transaction.phase === "awaitingRestore") {
        this.failOpen(output);
      } else if (this.transaction.inFrameParkStage !== "none") {
        // Strict in-frame parks do not permit printable payload between their
        // position/show tokens and the following DEC 2026 reset.
        this.transaction.inFrameParkStage = "none";
      }
      return;
    }
    output.append(byte);
  }

  private consumeEscapeByte(byte: number, now: number, output: EmissionBuilder): void {
    const escape = this.lexical as Extract<LexicalState, { kind: "escape" }>;
    escape.bytes.push(byte);
    const control = controlStringKind(byte);
    if (
      byte === ESC &&
      this.transaction &&
      this.transaction.bytes.length >= this.maxBufferedBytes
    ) {
      this.failOpen(output);
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }
    if (this.transaction && !this.appendHeld(byte, output)) {
      this.setPassStateAfterEscapeByte(byte);
      return;
    }

    if (byte === ESC) {
      this.reconsumeEscape(escape.bytes.slice(0, -1), now, output);
      return;
    }

    if (byte === 0x5b) {
      this.lexical = {
        kind: "csi",
        bytes: escape.bytes,
        startedAt: escape.startedAt,
        ...(escape.heldStart === undefined ? {} : { heldStart: escape.heldStart }),
      };
      return;
    }

    if (control) {
      if (!this.transaction) output.appendMany(escape.bytes);
      if (this.transaction?.phase === "holdingFrame") {
        this.transaction.inFrameParkStage = "none";
      }
      this.lexical = { kind: "control", control, previousEsc: false };
      return;
    }

    if (this.transaction) {
      this.lexical = { kind: "normal" };
      if (this.transaction.phase === "awaitingRestore") {
        this.failOpen(output);
      } else if (this.transaction.inFrameParkStage !== "none") {
        this.transaction.inFrameParkStage = "none";
      }
    } else {
      output.appendMany(escape.bytes);
      this.lexical = { kind: "normal" };
    }
  }

  private consumeCsiByte(byte: number, now: number, output: EmissionBuilder): void {
    const csi = this.lexical as Extract<LexicalState, { kind: "csi" }>;
    csi.bytes.push(byte);
    if (
      byte === ESC &&
      this.transaction &&
      this.transaction.bytes.length >= this.maxBufferedBytes
    ) {
      this.failOpen(output);
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }
    if (this.transaction && !this.appendHeld(byte, output)) {
      this.setPassStateAfterCsiByte(byte, csi.bytes.length);
      return;
    }

    if (byte >= 0x40 && byte <= 0x7e) {
      this.lexical = { kind: "normal" };
      this.completeCsi(csi.bytes, csi.heldStart, csi.startedAt, now, output);
      return;
    }

    const isParameterOrIntermediate = byte >= 0x20 && byte <= 0x3f;
    if (!isParameterOrIntermediate || csi.bytes.length > MAX_CSI_BYTES) {
      if (byte === ESC) {
        this.reconsumeEscape(csi.bytes.slice(0, -1), now, output);
        return;
      }
      this.lexical = { kind: "normal" };
      if (this.transaction?.phase === "awaitingRestore") {
        this.failOpen(output);
      } else if (this.transaction?.phase === "holdingFrame") {
        this.transaction.inFrameParkStage = "none";
      } else if (!this.transaction) {
        output.appendMany(csi.bytes);
      }
    }
  }

  private reconsumeEscape(
    precedingUnheldBytes: readonly number[],
    now: number,
    output: EmissionBuilder,
  ): void {
    const transaction = this.transaction;
    if (!transaction) {
      output.appendMany(precedingUnheldBytes);
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }

    if (transaction.phase === "awaitingRestore") {
      // The current ESC cancels the partial sequence and belongs to the next
      // sequence. Fail open only the old transaction so a following frame
      // opener can start a fresh transaction from this same ESC byte.
      transaction.bytes.pop();
      this.failOpen(output);
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }

    this.lexical = {
      kind: "escape",
      bytes: [ESC],
      heldStart: transaction.bytes.length - 1,
      startedAt: now,
    };
    transaction.inFrameParkStage = "none";
  }

  private consumeControlByte(byte: number, output: EmissionBuilder): void {
    const control = this.lexical as Extract<LexicalState, { kind: "control" }>;
    if (this.transaction) {
      if (!this.appendHeld(byte, output)) {
        this.lexical = isControlStringEnd(control.control, control.previousEsc, byte)
          ? { kind: "normal" }
          : { kind: "passControl", control: control.control, previousEsc: byte === ESC };
        return;
      }
    } else {
      output.append(byte);
    }

    if (isControlStringEnd(control.control, control.previousEsc, byte)) {
      this.lexical = { kind: "normal" };
      if (this.transaction?.phase === "awaitingRestore") this.failOpen(output);
    } else {
      control.previousEsc = byte === ESC;
    }
  }

  private consumePassEscapeByte(byte: number, now: number, output: EmissionBuilder): void {
    if (byte === ESC) {
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }
    output.append(byte);
    this.setPassStateAfterEscapeByte(byte);
  }

  private consumePassCsiByte(byte: number, now: number, output: EmissionBuilder): void {
    const csi = this.lexical as Extract<LexicalState, { kind: "passCsi" }>;
    if (byte === ESC) {
      this.lexical = { kind: "escape", bytes: [ESC], startedAt: now };
      return;
    }
    output.append(byte);
    this.setPassStateAfterCsiByte(byte, csi.bytesSeen + 1);
  }

  private setPassStateAfterEscapeByte(byte: number): void {
    if (byte === 0x5b) {
      this.lexical = { kind: "passCsi", bytesSeen: 2 };
      return;
    }
    const control = controlStringKind(byte);
    if (control) {
      this.lexical = { kind: "passControl", control, previousEsc: false };
      return;
    }
    this.lexical = byte === ESC ? { kind: "passEscape" } : { kind: "normal" };
  }

  private setPassStateAfterCsiByte(byte: number, bytesSeen: number): void {
    if (byte >= 0x40 && byte <= 0x7e) {
      this.lexical = { kind: "normal" };
      return;
    }
    if (byte >= 0x20 && byte <= 0x3f && bytesSeen <= MAX_CSI_BYTES) {
      this.lexical = { kind: "passCsi", bytesSeen };
      return;
    }
    this.lexical = byte === ESC ? { kind: "passEscape" } : { kind: "normal" };
  }

  private completeCsi(
    token: number[],
    heldStart: number | undefined,
    tokenStartedAt: number,
    now: number,
    output: EmissionBuilder,
  ): void {
    const kind = classifyCsi(token);
    if (!this.transaction) {
      if (kind === "frameStart") {
        this.startTransaction(token, tokenStartedAt, output);
      } else {
        output.appendMany(token);
      }
      return;
    }

    const transaction = this.transaction;
    const tokenStart = heldStart ?? transaction.bytes.length - token.length;
    if (transaction.phase === "holdingFrame") {
      if (kind === "cursorShow") {
        transaction.omitOnSuccess.push({ start: tokenStart, end: transaction.bytes.length });
        transaction.inFrameParkStage =
          transaction.inFrameParkStage === "positionsBeforeShow" ||
          transaction.inFrameParkStage === "showThenPositioned"
            ? "positionThenShown"
            : "shown";
      } else if (kind === "position") {
        transaction.inFrameParkStage =
          transaction.inFrameParkStage === "shown" ||
          transaction.inFrameParkStage === "showThenPositioned" ||
          transaction.inFrameParkStage === "positionThenShown"
            ? "showThenPositioned"
            : "positionsBeforeShow";
      } else if (kind === "frameEnd") {
        if (
          transaction.inFrameParkStage === "showThenPositioned" ||
          transaction.inFrameParkStage === "positionThenShown"
        ) {
          // The show belongs to the final caret, not to a transient footer.
          // Keep it in the atomic write so xterm's application DECTCEM state
          // stays current; DEC 2026 prevents a paint between either strict
          // position/show ordering and this frame reset.
          transaction.omitOnSuccess.pop();
          this.completeTransaction(output, true);
          return;
        }
        transaction.phase = "awaitingRestore";
        transaction.restoreStage = "hide";
        transaction.frameEndAt = now;
      } else if (kind === "frameEndCombined") {
        // xterm closes synchronized output for any valid private-mode reset
        // containing 2026. Only the singleton reset can complete a strict
        // cursor park; a combined reset must close this candidate fail-open.
        transaction.frameEndAt = now;
        this.failOpen(output);
      } else if (kind === "frameStart") {
        this.failOpen(output);
      } else if (transaction.inFrameParkStage !== "none") {
        transaction.inFrameParkStage = "none";
      }
      return;
    }

    if (kind === "frameStart") {
      const previous = transaction.bytes.splice(tokenStart);
      this.failOpen(output);
      this.startTransaction(previous, tokenStartedAt, output);
      return;
    }

    if (transaction.restoreStage === "hide" && kind === "cursorHide") {
      transaction.restoreStage = "position";
      return;
    }
    if (transaction.restoreStage === "position" && kind === "position") {
      transaction.restoreStage = "show";
      return;
    }
    if (transaction.restoreStage === "show" && kind === "position") return;
    if (transaction.restoreStage === "show" && kind === "cursorShow") {
      this.completeTransaction(output);
      return;
    }
    this.failOpen(output);
  }

  private startTransaction(token: number[], startedAt: number, output: EmissionBuilder): void {
    this.transaction = {
      phase: "holdingFrame",
      restoreStage: "hide",
      bytes: [...token],
      omitOnSuccess: [],
      frameStartAt: startedAt,
      deadline: startedAt + this.holdMs,
      inFrameParkStage: "none",
    };
    if (this.transaction.bytes.length > this.maxBufferedBytes) this.failOpen(output);
  }

  private appendHeld(byte: number, output: EmissionBuilder): boolean {
    const transaction = this.transaction;
    if (!transaction) return true;
    transaction.bytes.push(byte);
    if (transaction.bytes.length <= this.maxBufferedBytes) return true;
    this.failOpen(output);
    return false;
  }

  private completeTransaction(output: EmissionBuilder, frameEndCursorAuthoritative = false): void {
    const transaction = this.transaction;
    if (!transaction) return;
    const visible: number[] = [];
    let cursor = 0;
    for (const range of transaction.omitOnSuccess) {
      for (let index = cursor; index < range.start; index += 1) {
        visible.push(transaction.bytes[index]);
      }
      cursor = range.end;
    }
    for (let index = cursor; index < transaction.bytes.length; index += 1) {
      visible.push(transaction.bytes[index]);
    }
    output.emit(
      visible,
      true,
      frameEndCursorAuthoritative ? undefined : parkDeadline(transaction, this.holdMs),
      frameEndCursorAuthoritative,
    );
    this.transaction = undefined;
  }

  private failOpen(output: EmissionBuilder, preservePartialLexicalState = false): void {
    const transaction = this.transaction;
    if (!transaction) return;
    output.emit(transaction.bytes, false, parkDeadline(transaction, this.holdMs));
    this.transaction = undefined;

    if (preservePartialLexicalState) {
      if (this.lexical.kind === "escape") {
        this.lexical = { kind: "passEscape" };
      } else if (this.lexical.kind === "csi") {
        this.lexical = { kind: "passCsi", bytesSeen: this.lexical.bytes.length };
      } else if (this.lexical.kind === "control") {
        this.lexical = {
          kind: "passControl",
          control: this.lexical.control,
          previousEsc: this.lexical.previousEsc,
        };
      }
    }
  }

  private expireIfNeeded(now: number, output: EmissionBuilder): void {
    if (!this.transaction || now < this.transaction.deadline) return;
    this.failOpen(output, true);
  }
}

class EmissionBuilder {
  private pending: number[] = [];
  private emissions: StabilizedOutputEmission[] = [];

  append(byte: number): void {
    this.pending.push(byte);
  }

  appendMany(bytes: readonly number[]): void {
    this.pending.push(...bytes);
  }

  emit(
    bytes: readonly number[],
    stabilized: boolean,
    parkDeadline?: number,
    frameEndCursorAuthoritative = false,
  ): void {
    this.flushPending();
    if (bytes.length === 0) return;
    this.emissions.push({
      data: Uint8Array.from(bytes),
      stabilized,
      ...(parkDeadline === undefined ? {} : { parkDeadline }),
      ...(frameEndCursorAuthoritative ? { frameEndCursorAuthoritative: true } : {}),
    });
  }

  finish(): StabilizedOutputEmission[] {
    this.flushPending();
    return this.emissions;
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    this.emissions.push({ data: Uint8Array.from(this.pending), stabilized: false });
    this.pending = [];
  }
}

function controlStringKind(byte: number): ControlStringKind | undefined {
  if (byte === 0x5d) return "osc";
  if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) return "st";
  return undefined;
}

function isControlStringEnd(kind: ControlStringKind, previousEsc: boolean, byte: number): boolean {
  return (kind === "osc" && byte === BEL) || (previousEsc && byte === 0x5c);
}

type CsiKind =
  | "frameStart"
  | "frameEnd"
  | "frameEndCombined"
  | "cursorHide"
  | "cursorShow"
  | "position"
  | "other";

function classifyCsi(bytes: readonly number[]): CsiKind {
  const text = String.fromCharCode(...bytes);
  if (text === "\x1b[?2026h") return "frameStart";
  if (text === "\x1b[?2026l") return "frameEnd";
  if (hasPrivateModeParameter(text, "l", 2026)) return "frameEndCombined";
  if (text === "\x1b[?25l") return "cursorHide";
  if (text === "\x1b[?25h") return "cursorShow";
  const body = text.slice(2, -1);
  const final = text.at(-1);
  if ((final === "H" || final === "f") && /^[0-9;]*$/.test(body)) return "position";
  if (final === "G" && /^\d*$/.test(body)) return "position";
  return "other";
}

function hasPrivateModeParameter(text: string, final: "h" | "l", parameter: number): boolean {
  if (!text.startsWith("\x1b[?") || text.at(-1) !== final) return false;
  const body = text.slice(3, -1);
  if (!/^[0-9;]+$/.test(body)) return false;
  return body.split(";").some((value) => value !== "" && Number(value) === parameter);
}

function parkDeadline(transaction: Transaction, holdMs: number): number | undefined {
  return transaction.frameEndAt === undefined ? undefined : transaction.frameEndAt + holdMs;
}
