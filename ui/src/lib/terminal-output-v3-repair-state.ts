import {
  TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT,
  type TerminalOutputEnvelope,
} from "./terminal-output-envelope";
import { sameTerminalOutputEnvelope } from "./terminal-output-v3-envelope-ledger";
import type { TerminalOutputV3RepairRequest } from "./terminal-output-v3-repair-transport";
import type { TerminalOutputV3SurfaceResult } from "./terminal-output-v3-surface-controller";

export interface TerminalOutputV3PendingObservedEnvelope {
  readonly envelope: TerminalOutputEnvelope;
  readonly now: number;
  readonly promise: Promise<TerminalOutputV3SurfaceResult>;
  resolve(result: TerminalOutputV3SurfaceResult): void;
}

export interface TerminalOutputV3ActiveRepair {
  readonly request: Readonly<TerminalOutputV3RepairRequest>;
  winner?: TerminalOutputEnvelope;
}

export type TerminalOutputV3ObservedGapAdmission =
  | {
      readonly kind: "queued" | "duplicate";
      readonly promise: Promise<TerminalOutputV3SurfaceResult>;
    }
  | { readonly kind: "conflict" };

export type TerminalOutputV3RepairWinnerObservation = "none" | "winner" | "duplicate" | "conflict";

/** Owns the bounded observed successor chain and immutable direct-event witness for exact repair. */
export class TerminalOutputV3RepairState {
  private pendingObserved: TerminalOutputV3PendingObservedEnvelope[] = [];
  private activeRepair: TerminalOutputV3ActiveRepair | undefined;

  get pending(): TerminalOutputV3PendingObservedEnvelope | undefined {
    return this.pendingObserved[0];
  }

  queueObserved(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): TerminalOutputV3ObservedGapAdmission {
    const duplicate = this.pendingObserved.find(
      (pending) => pending.envelope.envelopeId === envelope.envelopeId,
    );
    if (duplicate) {
      return sameTerminalOutputEnvelope(duplicate.envelope, envelope)
        ? { kind: "duplicate", promise: duplicate.promise }
        : { kind: "conflict" };
    }
    const previous = this.pendingObserved.at(-1)?.envelope;
    if (
      this.pendingObserved.length >= TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT ||
      (previous &&
        (envelope.envelopeId !== previous.envelopeId + 1 || envelope.seqStart !== previous.seqEnd))
    ) {
      return { kind: "conflict" };
    }

    let resolve!: (result: TerminalOutputV3SurfaceResult) => void;
    const promise = new Promise<TerminalOutputV3SurfaceResult>((settle) => {
      resolve = settle;
    });
    this.pendingObserved.push({ envelope, now, promise, resolve });
    return { kind: "queued", promise };
  }

  detachPending(
    expected: TerminalOutputV3PendingObservedEnvelope,
  ): TerminalOutputV3PendingObservedEnvelope | undefined {
    if (this.pendingObserved[0] !== expected) return undefined;
    return this.pendingObserved.shift();
  }

  settlePending(result: TerminalOutputV3SurfaceResult): void {
    const pending = this.pendingObserved.splice(0);
    for (const item of pending) item.resolve(result);
  }

  begin(request: Readonly<TerminalOutputV3RepairRequest>): TerminalOutputV3ActiveRepair {
    const active = { request };
    this.activeRepair = active;
    return active;
  }

  finish(active: TerminalOutputV3ActiveRepair): void {
    if (this.activeRepair === active) this.activeRepair = undefined;
  }

  clearActive(): void {
    this.activeRepair = undefined;
  }

  observeWinner(envelope: TerminalOutputEnvelope): TerminalOutputV3RepairWinnerObservation {
    const active = this.activeRepair;
    if (!active || !matchesTerminalOutputV3RepairRequest(envelope, active.request)) return "none";
    if (!active.winner) {
      active.winner = envelope;
      return "winner";
    }
    return sameTerminalOutputEnvelope(active.winner, envelope) ? "duplicate" : "conflict";
  }

  witness(request: Readonly<TerminalOutputV3RepairRequest>): TerminalOutputEnvelope | undefined {
    const active = this.activeRepair;
    return active?.request === request ? active.winner : undefined;
  }
}

export function matchesTerminalOutputV3RepairRequest(
  envelope: TerminalOutputEnvelope,
  request: Readonly<TerminalOutputV3RepairRequest>,
): boolean {
  return (
    envelope.generation === request.generation &&
    envelope.leaseToken === request.token &&
    envelope.envelopeId === request.envelopeId &&
    envelope.grantId === request.grantId &&
    envelope.seqStart === request.seqStart
  );
}
