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
  | { kind: "passControl"; control: ControlStringKind; previousEsc: boolean };

type TransactionPhase = "holdingFrame" | "awaitingRestore";
type RestoreStage = "hide" | "position" | "show";

interface Transaction {
  phase: TransactionPhase;
  restoreStage: RestoreStage;
  bytes: number[];
  omitOnSuccess: Array<{ start: number; end: number }>;
  frameStartAt: number;
  deadline: number;
  frameEndAt?: number;
}

export interface StabilizedOutputEmission {
  data: Uint8Array;
  stabilized: boolean;
  parkDeadline?: number;
}

export interface NativeWindowsOutputStabilizerOptions {
  holdMs?: number;
  maxBufferedBytes?: number;
}

/**
 * Surface-local byte stream stabilizer for native Windows synchronized-output
 * frames. It only recognizes the narrow DEC 2026 + DECTCEM restore grammar;
 * every malformed, late, or oversized candidate is emitted byte-for-byte.
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
        this.consumeEscapeByte(byte, output);
        return;
      case "csi":
        this.consumeCsiByte(byte, now, output);
        return;
      case "control":
        this.consumeControlByte(byte, output);
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
      if (!this.appendHeld(byte, output)) return;
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
      if (this.transaction?.phase === "awaitingRestore") this.failOpen(output);
      return;
    }
    output.append(byte);
  }

  private consumeEscapeByte(byte: number, output: EmissionBuilder): void {
    const escape = this.lexical as Extract<LexicalState, { kind: "escape" }>;
    escape.bytes.push(byte);
    const control = controlStringKind(byte);
    if (this.transaction && !this.appendHeld(byte, output)) {
      if (control) {
        this.lexical = { kind: "passControl", control, previousEsc: false };
      }
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
      this.lexical = { kind: "control", control, previousEsc: false };
      return;
    }

    if (this.transaction) {
      this.lexical = { kind: "normal" };
      if (this.transaction.phase === "awaitingRestore") this.failOpen(output);
    } else {
      output.appendMany(escape.bytes);
      this.lexical = { kind: "normal" };
    }
  }

  private consumeCsiByte(byte: number, now: number, output: EmissionBuilder): void {
    const csi = this.lexical as Extract<LexicalState, { kind: "csi" }>;
    csi.bytes.push(byte);
    if (this.transaction && !this.appendHeld(byte, output)) return;

    if (byte >= 0x40 && byte <= 0x7e) {
      this.lexical = { kind: "normal" };
      this.completeCsi(csi.bytes, csi.heldStart, csi.startedAt, now, output);
      return;
    }

    const isParameterOrIntermediate = byte >= 0x20 && byte <= 0x3f;
    if (!isParameterOrIntermediate || csi.bytes.length > MAX_CSI_BYTES) {
      this.lexical = { kind: "normal" };
      if (this.transaction?.phase === "awaitingRestore") {
        this.failOpen(output);
      } else if (!this.transaction) {
        output.appendMany(csi.bytes);
      }
    }
  }

  private consumeControlByte(byte: number, output: EmissionBuilder): void {
    const control = this.lexical as Extract<LexicalState, { kind: "control" }>;
    if (this.transaction) {
      if (!this.appendHeld(byte, output)) {
        if (this.lexical.kind === "passControl") {
          if (isControlStringEnd(control.control, control.previousEsc, byte)) {
            this.lexical = { kind: "normal" };
          } else {
            this.lexical.previousEsc = byte === ESC;
          }
        }
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
      } else if (kind === "frameEnd") {
        transaction.phase = "awaitingRestore";
        transaction.restoreStage = "hide";
        transaction.frameEndAt = now;
      } else if (kind === "frameStart") {
        this.failOpen(output);
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
    };
    if (this.transaction.bytes.length > this.maxBufferedBytes) this.failOpen(output);
  }

  private appendHeld(byte: number, output: EmissionBuilder): boolean {
    const transaction = this.transaction;
    if (!transaction) return true;
    transaction.bytes.push(byte);
    if (transaction.bytes.length <= this.maxBufferedBytes) return true;
    this.failOpen(output, true);
    if (this.lexical.kind === "escape" || this.lexical.kind === "csi") {
      this.lexical = { kind: "normal" };
    }
    return false;
  }

  private completeTransaction(output: EmissionBuilder): void {
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
    output.emit(visible, true, parkDeadline(transaction, this.holdMs));
    this.transaction = undefined;
  }

  private failOpen(output: EmissionBuilder, preserveControl = false): void {
    const transaction = this.transaction;
    if (!transaction) return;
    output.emit(transaction.bytes, false, parkDeadline(transaction, this.holdMs));
    this.transaction = undefined;

    if (preserveControl && this.lexical.kind === "control") {
      this.lexical = {
        kind: "passControl",
        control: this.lexical.control,
        previousEsc: this.lexical.previousEsc,
      };
    }
  }

  private expireIfNeeded(now: number, output: EmissionBuilder): void {
    if (!this.transaction || now < this.transaction.deadline) return;
    this.failOpen(output, this.lexical.kind === "control");
    if (this.lexical.kind === "escape" || this.lexical.kind === "csi") {
      this.lexical = { kind: "normal" };
    }
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

  emit(bytes: readonly number[], stabilized: boolean, parkDeadline?: number): void {
    this.flushPending();
    if (bytes.length === 0) return;
    this.emissions.push({
      data: Uint8Array.from(bytes),
      stabilized,
      ...(parkDeadline === undefined ? {} : { parkDeadline }),
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

type CsiKind = "frameStart" | "frameEnd" | "cursorHide" | "cursorShow" | "position" | "other";

function classifyCsi(bytes: readonly number[]): CsiKind {
  const text = String.fromCharCode(...bytes);
  if (text === "\x1b[?2026h") return "frameStart";
  if (text === "\x1b[?2026l") return "frameEnd";
  if (text === "\x1b[?25l") return "cursorHide";
  if (text === "\x1b[?25h") return "cursorShow";
  const body = text.slice(2, -1);
  const final = text.at(-1);
  if ((final === "H" || final === "f") && /^[0-9;]*$/.test(body)) return "position";
  if (final === "G" && /^\d*$/.test(body)) return "position";
  return "other";
}

function parkDeadline(transaction: Transaction, holdMs: number): number | undefined {
  return transaction.frameEndAt === undefined ? undefined : transaction.frameEndAt + holdMs;
}
