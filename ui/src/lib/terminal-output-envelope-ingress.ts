import {
  normalizeTerminalOutputEnvelope,
  type TerminalOutputEnvelope,
} from "./terminal-output-envelope";

export interface TerminalOutputEnvelopeIngressOptions {
  terminalId: string;
  generation: number;
  leaseToken: string;
  initialSeq: number;
  initialEnvelopeId?: number;
}

export interface TerminalOutputReceiptIdentity {
  terminalId: string;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
}

export interface TerminalOutputParsedIdentity {
  terminalId: string;
  generation: number;
  leaseToken: string;
  seq: number;
}

export interface TerminalOutputUnparsedRange {
  envelopeId: number;
  grantId: string | null;
  seqStart: number;
  seqEnd: number;
  sourceBytes: number;
  originalDeltaCount: number;
}

export interface TerminalOutputUnreceiptedEnvelope {
  identity: TerminalOutputReceiptIdentity;
  backing: Uint8Array;
}

export type TerminalOutputReceiptCompletion = "accepted" | "duplicate" | "stale";
export type TerminalOutputParsedCompletion = "accepted" | "duplicate" | "stale";

export type TerminalOutputEnvelopeIngressErrorCode =
  | "receipt-pending"
  | "session-mismatch"
  | "envelope-order"
  | "sequence"
  | "parsed-range";

export class TerminalOutputEnvelopeIngressError extends Error {
  constructor(
    readonly code: TerminalOutputEnvelopeIngressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalOutputEnvelopeIngressError";
  }
}

/**
 * Generation-local v3 transport admission.
 *
 * Receipt releases only the decoded backing slot. Parsed completion releases
 * only source-range ledgers. Keeping those transitions separate prevents a
 * transport acknowledgement from advancing desktop parsed credit.
 */
export class TerminalOutputEnvelopeIngress {
  readonly terminalId: string;
  readonly generation: number;
  readonly leaseToken: string;

  private nextSeq: number;
  private nextEnvelopeId: number;
  private parsedFrontier: number;
  private pendingReceipt: TerminalOutputUnreceiptedEnvelope | undefined;
  private lastReceipt: TerminalOutputReceiptIdentity | undefined;
  private unparsedRanges: TerminalOutputUnparsedRange[] = [];

  constructor(options: TerminalOutputEnvelopeIngressOptions) {
    if (options.terminalId.length === 0) throw new Error("terminal id must not be empty");
    if (!isNonnegativeSafeInteger(options.generation)) {
      throw new Error("terminal generation must be a nonnegative safe integer");
    }
    if (options.leaseToken.length === 0) throw new Error("terminal lease token must not be empty");
    if (!isNonnegativeSafeInteger(options.initialSeq)) {
      throw new Error("terminal initial sequence must be a nonnegative safe integer");
    }
    const initialEnvelopeId = options.initialEnvelopeId ?? 1;
    if (!isPositiveSafeInteger(initialEnvelopeId)) {
      throw new Error("terminal initial envelope id must be a positive safe integer");
    }

    this.terminalId = options.terminalId;
    this.generation = options.generation;
    this.leaseToken = options.leaseToken;
    this.nextSeq = options.initialSeq;
    this.parsedFrontier = options.initialSeq;
    this.nextEnvelopeId = initialEnvelopeId;
  }

  get admittedSeq(): number {
    return this.nextSeq;
  }

  get parsedSeq(): number {
    return this.parsedFrontier;
  }

  get expectedEnvelopeId(): number {
    return this.nextEnvelopeId;
  }

  get unreceipted(): TerminalOutputUnreceiptedEnvelope | undefined {
    const pending = this.pendingReceipt;
    return pending ? { identity: { ...pending.identity }, backing: pending.backing } : undefined;
  }

  get unparsed(): readonly TerminalOutputUnparsedRange[] {
    return this.unparsedRanges.map((range) => ({ ...range }));
  }

  /** Validate the whole envelope, then atomically append both transport ledgers. */
  accept(value: unknown): TerminalOutputEnvelope {
    return this.acceptValidated(normalizeTerminalOutputEnvelope(value));
  }

  /** Admit an envelope already validated by the transport boundary. */
  acceptValidated(envelope: TerminalOutputEnvelope): TerminalOutputEnvelope {
    if (this.pendingReceipt) {
      throw new TerminalOutputEnvelopeIngressError(
        "receipt-pending",
        "terminal output envelope receipt is still pending",
      );
    }
    if (envelope.generation !== this.generation || envelope.leaseToken !== this.leaseToken) {
      throw new TerminalOutputEnvelopeIngressError(
        "session-mismatch",
        "terminal output envelope belongs to another generation or lease",
      );
    }
    if (envelope.envelopeId !== this.nextEnvelopeId) {
      throw new TerminalOutputEnvelopeIngressError(
        "envelope-order",
        "terminal output envelope id is not the expected successor",
      );
    }
    if (envelope.seqStart !== this.nextSeq) {
      throw new TerminalOutputEnvelopeIngressError(
        "sequence",
        "terminal output envelope does not start at the admitted frontier",
      );
    }
    if (this.nextEnvelopeId === Number.MAX_SAFE_INTEGER) {
      throw new TerminalOutputEnvelopeIngressError(
        "envelope-order",
        "terminal output envelope id space is exhausted",
      );
    }

    const identity: TerminalOutputReceiptIdentity = {
      terminalId: this.terminalId,
      ...envelope.receiptIdentity,
    };
    const unparsed: TerminalOutputUnparsedRange = {
      envelopeId: envelope.envelopeId,
      grantId: envelope.grantId,
      seqStart: envelope.seqStart,
      seqEnd: envelope.seqEnd,
      sourceBytes: envelope.seqEnd - envelope.seqStart,
      originalDeltaCount: envelope.deltas.length,
    };

    this.pendingReceipt = { identity, backing: envelope.backing };
    this.unparsedRanges.push(unparsed);
    this.nextSeq = envelope.seqEnd;
    this.nextEnvelopeId += 1;
    return envelope;
  }

  completeReceipt(identity: TerminalOutputReceiptIdentity): TerminalOutputReceiptCompletion {
    if (this.lastReceipt && sameReceiptIdentity(identity, this.lastReceipt)) return "duplicate";
    const pending = this.pendingReceipt;
    if (!pending || !sameReceiptIdentity(identity, pending.identity)) return "stale";

    this.lastReceipt = { ...identity };
    this.pendingReceipt = undefined;
    return "accepted";
  }

  completeParsed(identity: TerminalOutputParsedIdentity): TerminalOutputParsedCompletion {
    if (!this.isCurrentParsedIdentity(identity)) return "stale";
    if (identity.seq === this.parsedFrontier) return "duplicate";
    if (identity.seq < this.parsedFrontier || identity.seq > this.nextSeq) {
      throw new TerminalOutputEnvelopeIngressError(
        "parsed-range",
        "terminal output parsed prefix is outside the admitted range",
      );
    }

    this.parsedFrontier = identity.seq;
    const remaining: TerminalOutputUnparsedRange[] = [];
    for (const range of this.unparsedRanges) {
      if (range.seqEnd <= identity.seq) continue;
      if (range.seqStart < identity.seq) {
        remaining.push({
          ...range,
          seqStart: identity.seq,
          sourceBytes: range.seqEnd - identity.seq,
        });
      } else {
        remaining.push(range);
      }
    }
    this.unparsedRanges = remaining;
    return "accepted";
  }

  snapshot(): {
    admittedSeq: number;
    parsedSeq: number;
    expectedEnvelopeId: number;
    unreceipted?: { identity: TerminalOutputReceiptIdentity; byteLength: number };
    unparsed: TerminalOutputUnparsedRange[];
  } {
    const pending = this.pendingReceipt;
    return {
      admittedSeq: this.nextSeq,
      parsedSeq: this.parsedFrontier,
      expectedEnvelopeId: this.nextEnvelopeId,
      ...(pending
        ? {
            unreceipted: {
              identity: { ...pending.identity },
              byteLength: pending.backing.byteLength,
            },
          }
        : {}),
      unparsed: this.unparsedRanges.map((range) => ({ ...range })),
    };
  }

  private isCurrentParsedIdentity(identity: TerminalOutputParsedIdentity): boolean {
    return (
      identity.terminalId === this.terminalId &&
      identity.generation === this.generation &&
      identity.leaseToken === this.leaseToken
    );
  }
}

function sameReceiptIdentity(
  left: TerminalOutputReceiptIdentity,
  right: TerminalOutputReceiptIdentity,
): boolean {
  return (
    left.terminalId === right.terminalId &&
    left.generation === right.generation &&
    left.leaseToken === right.leaseToken &&
    left.envelopeId === right.envelopeId &&
    left.grantId === right.grantId
  );
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
