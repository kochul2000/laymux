import type { TerminalOutputEnvelopeDelta } from "./terminal-output-envelope";
import { coalesceTerminalOutputSegments } from "./terminal-output-coalesce";
import type { TerminalOutputParsedIdentity } from "./terminal-output-envelope-ingress";
import type {
  TerminalOutputV3EnvelopeCompletion,
  TerminalOutputV3SurfaceAdapter,
  TerminalOutputV3TransferRequest,
} from "./terminal-output-v3-surface-controller";

export interface TerminalOutputV3TerminalAdapterOptions {
  terminalId: string;
  generation: number;
  leaseToken: string;
  initialParsedSeq: number;
  isCurrent(): boolean;
  applyCheckpoint(delta: TerminalOutputEnvelopeDelta): PromiseLike<void>;
  enqueueVisible(
    delta: TerminalOutputEnvelopeDelta,
    onParsed: (() => void) | undefined,
    onDiscard: (reason: string) => void,
  ): void;
  sendParsedRange(seqStart: number, seqEnd: number): Promise<boolean>;
  onFailStop(reason: string): void;
}

function coalesceCheckpointDeltas(
  deltas: readonly TerminalOutputEnvelopeDelta[],
): TerminalOutputEnvelopeDelta[] {
  const coalesced = coalesceTerminalOutputSegments(deltas);
  let sourceIndex = 0;
  return coalesced.map((segment) => {
    while (deltas[sourceIndex].seqStart < segment.seqStart) sourceIndex += 1;
    const first = deltas[sourceIndex];
    if (segment === first) return first;
    return {
      ...first,
      seqEnd: segment.seqEnd,
      data: segment.data,
      geometry: segment.geometry,
    };
  });
}

/** Bridges v3 semantic deltas into the existing two-parser terminal surface. */
export class TerminalOutputV3TerminalAdapter implements TerminalOutputV3SurfaceAdapter {
  private parsedRequestSeq: number;
  private disposed = false;

  constructor(private readonly options: TerminalOutputV3TerminalAdapterOptions) {
    this.parsedRequestSeq = options.initialParsedSeq;
  }

  preflight(
    envelope: Readonly<Parameters<TerminalOutputV3SurfaceAdapter["preflight"]>[0]>,
  ): { readonly kind: "accepted" } | { readonly kind: "rejected"; readonly reason: string } {
    if (this.disposed || !this.options.isCurrent()) {
      return { kind: "rejected", reason: "surface_stale" };
    }
    if (
      envelope.generation !== this.options.generation ||
      envelope.leaseToken !== this.options.leaseToken
    ) {
      return { kind: "rejected", reason: "session_mismatch" };
    }
    for (const delta of envelope.deltas) {
      if (
        delta.data.buffer !== envelope.backing.buffer ||
        delta.data.byteOffset < envelope.backing.byteOffset ||
        delta.data.byteOffset + delta.data.byteLength >
          envelope.backing.byteOffset + envelope.backing.byteLength
      ) {
        return { kind: "rejected", reason: "backing_replaced" };
      }
    }
    return { kind: "accepted" };
  }

  transfer(request: TerminalOutputV3TransferRequest): { readonly acceptedDeltaCount: number } {
    if (this.disposed || !this.options.isCurrent()) {
      throw new Error("terminal output v3 surface is stale");
    }

    const deltas = request.envelope.deltas;
    const checkpointDeltas = coalesceCheckpointDeltas(deltas);
    const checkpointParsed = Promise.all(
      checkpointDeltas.map((delta) => Promise.resolve(this.options.applyCheckpoint(delta))),
    ).then(() => undefined);
    let resolveVisible!: () => void;
    let rejectVisible!: (reason: unknown) => void;
    const visibleParsed = new Promise<void>((resolve, reject) => {
      resolveVisible = resolve;
      rejectVisible = reject;
    });
    let completed = false;
    const completeOnce = (completion: TerminalOutputV3EnvelopeCompletion) => {
      if (completed || this.disposed || !this.options.isCurrent()) return;
      completed = true;
      request.complete(completion);
    };

    void Promise.all([visibleParsed, checkpointParsed]).then(
      () =>
        completeOnce({
          kind: "parsed",
          visibleSeq: request.envelope.seqEnd,
          checkpointSeq: request.envelope.seqEnd,
        }),
      (error) =>
        completeOnce({
          kind: "discarded",
          reason: error instanceof Error ? error.message : "parser_failure",
        }),
    );

    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index];
      this.options.enqueueVisible(
        delta,
        index === deltas.length - 1 ? resolveVisible : undefined,
        (reason) => rejectVisible(new Error(reason)),
      );
    }
    return { acceptedDeltaCount: deltas.length };
  }

  async sendParsedAck(identity: TerminalOutputParsedIdentity): Promise<boolean> {
    if (
      this.disposed ||
      !this.options.isCurrent() ||
      identity.terminalId !== this.options.terminalId ||
      identity.generation !== this.options.generation ||
      identity.leaseToken !== this.options.leaseToken ||
      identity.seq < this.parsedRequestSeq
    ) {
      return false;
    }
    if (identity.seq === this.parsedRequestSeq) return true;
    const seqStart = this.parsedRequestSeq;
    this.parsedRequestSeq = identity.seq;
    return this.options.sendParsedRange(seqStart, identity.seq);
  }

  failStop(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.onFailStop(reason);
  }

  dispose(): void {
    this.disposed = true;
  }
}
