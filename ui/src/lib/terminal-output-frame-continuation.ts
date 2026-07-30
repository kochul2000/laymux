const ESC = 0x1b;
const BEL = 0x07;
const DEFAULT_TIMEOUT_MS = 50;
const MAX_CSI_BYTES = 32;

export const TERMINAL_OUTPUT_BASE_CREDIT_BYTES = 512 * 1024;
export const TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES = 1024 * 1024;

export type TerminalOutputContinuationSurface = "bootstrap" | "active" | "reattach";
export type TerminalOutputFrameFailOpenReason = "malformed" | "timeout" | "oversized";

export interface TerminalOutputFrameContinuationGrantSeed {
  terminalId: string;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  frameStartSeq: number;
}

export interface TerminalOutputFrameContinuationGrant {
  readonly terminalId: string;
  readonly generation: number;
  readonly leaseToken: string;
  /** The envelope containing the raw ESC byte that started the frame. */
  readonly envelopeId: number;
  readonly grantId: string;
}

export type TerminalOutputFrameContinuationTransition =
  | {
      readonly type: "opened";
      readonly frameStartSeq: number;
      readonly maxFrameEndSeq: number;
      /** Bootstrap observes framing but must never request continuation credit. */
      readonly grant: TerminalOutputFrameContinuationGrant | null;
    }
  | {
      readonly type: "closed";
      /** Envelope that observed the terminator/failure, or the last byte before timeout. */
      readonly envelopeId: number;
      readonly frameStartSeq: number;
      /** Exclusive raw source sequence after the last observed frame byte. */
      readonly frameEndSeq: number;
      readonly frameBytes: number;
      readonly outcome: "complete" | "fail-open";
      readonly reason: "terminator" | TerminalOutputFrameFailOpenReason;
      readonly grant: TerminalOutputFrameContinuationGrant | null;
      /** The control-plane result required for an issued grant. */
      readonly grantResult: "close" | "abort" | null;
    };

export interface TerminalOutputFrameContinuationTrackerOptions {
  surface: TerminalOutputContinuationSurface;
  terminalId: string;
  generation: number;
  leaseToken: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  createGrantId?: (seed: TerminalOutputFrameContinuationGrantSeed) => string;
}

export interface TerminalOutputFrameContinuationInput {
  /** Raw, pre-stabilizer bytes. This object is forwarded unchanged. */
  data: Uint8Array;
  sourceStartSeq: number;
  envelopeId: number;
  /** True only after both parser surfaces are live and the mount-local owner reports healthy. */
  healthyLiveSurface: boolean;
  now: number;
}

export interface TerminalOutputFrameContinuationObservation {
  /** Always the exact input object; this tracker never owns emission or cursor policy. */
  readonly forward: Uint8Array;
  readonly transitions: readonly TerminalOutputFrameContinuationTransition[];
}

type ControlStringKind = "osc" | "st";
type LexicalState =
  | { kind: "normal" }
  | {
      kind: "escape";
      sourceStartSeq: number;
      envelopeId: number;
      healthyLiveSurface: boolean;
      startedAt: number;
    }
  | {
      kind: "csi";
      bytes: number[];
      sourceStartSeq: number;
      envelopeId: number;
      healthyLiveSurface: boolean;
      startedAt: number;
    }
  | { kind: "control"; control: ControlStringKind; previousEsc: boolean };

interface OpenFrame {
  frameStartSeq: number;
  deadline: number;
  lastEnvelopeId: number;
  grant: TerminalOutputFrameContinuationGrant | null;
}

type FrameToken = "open" | "close" | "malformed" | "other";

/**
 * Observes raw source bytes and reports DECSET 2026 continuation lifecycle.
 *
 * It deliberately does not buffer, rewrite, delay, or synthesize bytes. The
 * existing native stabilizer remains the sole owner of atomic emission and
 * cursor semantics; this primitive only provides bounded credit decisions.
 */
export class TerminalOutputFrameContinuationTracker {
  private readonly surface: TerminalOutputContinuationSurface;
  private readonly terminalId: string;
  private readonly generation: number;
  private readonly leaseToken: string;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly createGrantId: (seed: TerminalOutputFrameContinuationGrantSeed) => string;
  private lexical: LexicalState = { kind: "normal" };
  private frame: OpenFrame | undefined;
  /** After fail-open, ignore further markers until the original frame terminator. */
  private suppressUntilFrameClose = false;
  private nextSourceSeq: number | undefined;

  constructor(options: TerminalOutputFrameContinuationTrackerOptions) {
    assertNonEmpty("terminalId", options.terminalId);
    assertNonEmpty("leaseToken", options.leaseToken);
    assertSafeSequence("generation", options.generation);
    this.surface = options.surface;
    this.terminalId = options.terminalId;
    this.generation = options.generation;
    this.leaseToken = options.leaseToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES;
    this.createGrantId = options.createGrantId ?? createOpaqueGrantId;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative finite number");
    }
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < FRAME_OPEN_BYTES.length) {
      throw new RangeError("maxFrameBytes must fit a complete DECSET 2026 opener");
    }
  }

  get deadline(): number | undefined {
    return this.frame?.deadline;
  }

  get expectedSourceSeq(): number | undefined {
    return this.nextSourceSeq;
  }

  observe(input: TerminalOutputFrameContinuationInput): TerminalOutputFrameContinuationObservation {
    assertSafeSequence("sourceStartSeq", input.sourceStartSeq);
    assertPositiveSafeInteger("envelopeId", input.envelopeId);
    if (this.nextSourceSeq !== undefined && input.sourceStartSeq !== this.nextSourceSeq) {
      throw new RangeError(
        `terminal output requires a contiguous source sequence: expected ${this.nextSourceSeq}, got ${input.sourceStartSeq}`,
      );
    }
    const sourceEndSeq = input.sourceStartSeq + input.data.byteLength;
    assertSafeSequence("sourceEndSeq", sourceEndSeq);

    const transitions: TerminalOutputFrameContinuationTransition[] = [];
    this.expireIfNeeded(input.now, transitions);
    for (let index = 0; index < input.data.byteLength; index += 1) {
      const byteSeq = input.sourceStartSeq + index;
      this.consumeByte(
        input.data[index],
        byteSeq,
        input.envelopeId,
        input.healthyLiveSurface,
        input.now,
        transitions,
      );
    }
    this.nextSourceSeq = sourceEndSeq;
    return { forward: input.data, transitions };
  }

  flushExpired(now: number): readonly TerminalOutputFrameContinuationTransition[] {
    const transitions: TerminalOutputFrameContinuationTransition[] = [];
    this.expireIfNeeded(now, transitions);
    return transitions;
  }

  private consumeByte(
    byte: number,
    byteSeq: number,
    envelopeId: number,
    healthyLiveSurface: boolean,
    now: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    if (this.frame && byteSeq + 1 - this.frame.frameStartSeq > this.maxFrameBytes) {
      this.failOpen("oversized", byteSeq + 1, envelopeId, transitions);
    } else if (this.frame) {
      this.frame.deadline = now + this.timeoutMs;
      this.frame.lastEnvelopeId = envelopeId;
    }

    switch (this.lexical.kind) {
      case "normal":
        if (byte === ESC) {
          this.lexical = {
            kind: "escape",
            sourceStartSeq: byteSeq,
            envelopeId,
            healthyLiveSurface,
            startedAt: now,
          };
        }
        return;
      case "escape":
        this.consumeEscapeByte(byte, byteSeq, envelopeId, healthyLiveSurface, now, transitions);
        return;
      case "csi":
        this.consumeCsiByte(byte, byteSeq, envelopeId, healthyLiveSurface, now, transitions);
        return;
      case "control":
        if (isControlStringEnd(this.lexical.control, this.lexical.previousEsc, byte)) {
          this.lexical = { kind: "normal" };
        } else {
          this.lexical.previousEsc = byte === ESC;
        }
    }
  }

  private consumeEscapeByte(
    byte: number,
    byteSeq: number,
    envelopeId: number,
    healthyLiveSurface: boolean,
    now: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    const escape = this.lexical as Extract<LexicalState, { kind: "escape" }>;
    if (byte === 0x5b) {
      this.lexical = {
        kind: "csi",
        bytes: [ESC, byte],
        sourceStartSeq: escape.sourceStartSeq,
        envelopeId: escape.envelopeId,
        healthyLiveSurface: escape.healthyLiveSurface,
        startedAt: escape.startedAt,
      };
      return;
    }
    const control = controlStringKind(byte);
    if (control) {
      this.lexical = { kind: "control", control, previousEsc: false };
      return;
    }
    this.lexical = { kind: "normal" };
    if (byte === ESC) {
      this.consumeByte(byte, byteSeq, envelopeId, healthyLiveSurface, now, transitions);
    }
  }

  private consumeCsiByte(
    byte: number,
    byteSeq: number,
    envelopeId: number,
    healthyLiveSurface: boolean,
    now: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    const csi = this.lexical as Extract<LexicalState, { kind: "csi" }>;
    csi.bytes.push(byte);
    if (byte >= 0x40 && byte <= 0x7e) {
      this.lexical = { kind: "normal" };
      this.completeCsi(classifyFrameToken(csi.bytes), csi, byteSeq + 1, envelopeId, transitions);
      return;
    }
    if (byte >= 0x20 && byte <= 0x3f && csi.bytes.length <= MAX_CSI_BYTES) return;

    this.lexical = { kind: "normal" };
    if (this.frame && startsLikeFrameControl(csi.bytes)) {
      this.failOpen("malformed", byteSeq + 1, envelopeId, transitions);
    }
    if (byte === ESC) {
      this.consumeByte(byte, byteSeq, envelopeId, healthyLiveSurface, now, transitions);
    }
  }

  private completeCsi(
    token: FrameToken,
    csi: Extract<LexicalState, { kind: "csi" }>,
    tokenEndSeq: number,
    envelopeId: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    if (this.suppressUntilFrameClose) {
      if (token === "close") this.suppressUntilFrameClose = false;
      return;
    }
    if (!this.frame) {
      if (token === "open") {
        this.openFrame(
          csi.sourceStartSeq,
          csi.envelopeId,
          csi.healthyLiveSurface,
          csi.startedAt,
          transitions,
        );
      }
      return;
    }
    if (token === "close") {
      this.closeFrame(tokenEndSeq, envelopeId, transitions);
    } else if (token === "open" || token === "malformed") {
      this.failOpen("malformed", tokenEndSeq, envelopeId, transitions);
    }
  }

  private openFrame(
    frameStartSeq: number,
    envelopeId: number,
    healthyLiveSurface: boolean,
    now: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    const seed: TerminalOutputFrameContinuationGrantSeed = {
      terminalId: this.terminalId,
      generation: this.generation,
      leaseToken: this.leaseToken,
      envelopeId,
      frameStartSeq,
    };
    let grant: TerminalOutputFrameContinuationGrant | null = null;
    if (this.surface !== "bootstrap" && healthyLiveSurface) {
      const grantId = this.createGrantId(seed);
      assertNonEmpty("grantId", grantId);
      grant = Object.freeze({
        terminalId: this.terminalId,
        generation: this.generation,
        leaseToken: this.leaseToken,
        envelopeId,
        grantId,
      });
    }
    this.frame = {
      frameStartSeq,
      deadline: now + this.timeoutMs,
      lastEnvelopeId: envelopeId,
      grant,
    };
    transitions.push({
      type: "opened",
      frameStartSeq,
      maxFrameEndSeq: frameStartSeq + this.maxFrameBytes,
      grant,
    });
  }

  private closeFrame(
    frameEndSeq: number,
    envelopeId: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    const frame = this.frame;
    if (!frame) return;
    transitions.push({
      type: "closed",
      envelopeId,
      frameStartSeq: frame.frameStartSeq,
      frameEndSeq,
      frameBytes: frameEndSeq - frame.frameStartSeq,
      outcome: "complete",
      reason: "terminator",
      grant: frame.grant,
      grantResult: frame.grant ? "close" : null,
    });
    this.frame = undefined;
  }

  private failOpen(
    reason: TerminalOutputFrameFailOpenReason,
    frameEndSeq: number,
    envelopeId: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    const frame = this.frame;
    if (!frame) return;
    transitions.push({
      type: "closed",
      envelopeId,
      frameStartSeq: frame.frameStartSeq,
      frameEndSeq,
      frameBytes: frameEndSeq - frame.frameStartSeq,
      outcome: "fail-open",
      reason,
      grant: frame.grant,
      grantResult: frame.grant ? "abort" : null,
    });
    this.frame = undefined;
    this.suppressUntilFrameClose = true;
  }

  private expireIfNeeded(
    now: number,
    transitions: TerminalOutputFrameContinuationTransition[],
  ): void {
    if (!this.frame || now < this.frame.deadline) return;
    this.failOpen(
      "timeout",
      this.nextSourceSeq ?? this.frame.frameStartSeq,
      this.frame.lastEnvelopeId,
      transitions,
    );
  }
}

const FRAME_OPEN_BYTES = [ESC, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68] as const;
const FRAME_CLOSE_BYTES = [ESC, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c] as const;

function classifyFrameToken(bytes: readonly number[]): FrameToken {
  if (equalBytes(bytes, FRAME_OPEN_BYTES)) return "open";
  if (equalBytes(bytes, FRAME_CLOSE_BYTES)) return "close";
  return startsLikeFrameControl(bytes) ? "malformed" : "other";
}

function startsLikeFrameControl(bytes: readonly number[]): boolean {
  const prefix = FRAME_OPEN_BYTES.slice(0, -1);
  if (bytes.length < prefix.length) return false;
  return equalBytes(bytes.slice(0, prefix.length), prefix);
}

function equalBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function controlStringKind(byte: number): ControlStringKind | undefined {
  if (byte === 0x5d) return "osc";
  if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) return "st";
  return undefined;
}

function isControlStringEnd(kind: ControlStringKind, previousEsc: boolean, byte: number): boolean {
  return (kind === "osc" && byte === BEL) || (previousEsc && byte === 0x5c);
}

function createOpaqueGrantId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
}

function assertSafeSequence(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
