import type {
  TerminalOutputDeliveryControlRequest,
  TerminalOutputDeliveryControlResult,
  TerminalOutputDeliveryControlSender,
} from "./terminal-output-delivery-control";
import {
  normalizeTerminalOutputEnvelope,
  type TerminalOutputEnvelope,
} from "./terminal-output-envelope";
import {
  TerminalOutputEnvelopeIngressError,
  type TerminalOutputEnvelopeIngress,
  type TerminalOutputParsedIdentity,
} from "./terminal-output-envelope-ingress";
import type {
  TerminalOutputFrameContinuationTracker,
  TerminalOutputFrameContinuationTransition,
} from "./terminal-output-frame-continuation";
import {
  terminalOutputSurfaceAvailability,
  type TerminalOutputSurfaceLifecycle,
} from "./terminal-output-surface-lifecycle";
import {
  TerminalOutputV3EnvelopeLedger,
  type TerminalOutputV3KnownEnvelopeMatch,
  type TerminalOutputV3RepairIdentity,
} from "./terminal-output-v3-envelope-ledger";
import { TerminalOutputV3ContinuationControl } from "./terminal-output-v3-continuation-control";

export type TerminalOutputV3EnvelopeCompletion =
  | {
      readonly kind: "parsed";
      readonly visibleSeq: number;
      readonly checkpointSeq: number;
    }
  | { readonly kind: "discarded"; readonly reason: string };

export interface TerminalOutputV3TransferRequest {
  readonly envelope: TerminalOutputEnvelope;
  readonly complete: (completion: TerminalOutputV3EnvelopeCompletion) => void;
}
export interface TerminalOutputV3SurfaceAdapter {
  preflight(
    envelope: Readonly<TerminalOutputEnvelope>,
  ): { readonly kind: "accepted" } | { readonly kind: "rejected"; readonly reason: string };
  transfer(request: TerminalOutputV3TransferRequest): { readonly acceptedDeltaCount: number };
  sendParsedAck(identity: TerminalOutputParsedIdentity): Promise<boolean>;
  failStop(reason: string): void;
}

export type TerminalOutputV3SurfaceResult =
  | { readonly kind: "accepted"; readonly envelopeId: number }
  | { readonly kind: "stale" }
  | { readonly kind: "fail-stop"; readonly reason: string };
export interface TerminalOutputV3SurfaceControllerOptions {
  ingress: TerminalOutputEnvelopeIngress;
  continuation: TerminalOutputFrameContinuationTracker;
  deliveryControl: Pick<TerminalOutputDeliveryControlSender, "send" | "dispose">;
  getLifecycle(): TerminalOutputSurfaceLifecycle;
  adapter: TerminalOutputV3SurfaceAdapter;
}

interface CompletionRecord {
  envelope: TerminalOutputEnvelope;
  transferred: boolean;
  transitionsSettled: boolean;
  received: boolean;
  pending?: TerminalOutputV3EnvelopeCompletion;
}

/** Coordinates existing v3 owners without reset, replay, or replacement attach. */
export class TerminalOutputV3SurfaceController {
  private readonly ingress: TerminalOutputEnvelopeIngress;
  private readonly continuation: TerminalOutputFrameContinuationTracker;
  private readonly deliveryControl: Pick<TerminalOutputDeliveryControlSender, "send" | "dispose">;
  private readonly getLifecycle: () => TerminalOutputSurfaceLifecycle;
  private readonly adapter: TerminalOutputV3SurfaceAdapter;
  private readonly continuationControl: TerminalOutputV3ContinuationControl;
  private readonly ledger = new TerminalOutputV3EnvelopeLedger<
    Promise<TerminalOutputV3SurfaceResult>
  >();
  private unsettledDeliveryCount = 0;
  private failure: Extract<TerminalOutputV3SurfaceResult, { kind: "fail-stop" }> | undefined;

  constructor(options: TerminalOutputV3SurfaceControllerOptions) {
    this.ingress = options.ingress;
    this.continuation = options.continuation;
    this.deliveryControl = options.deliveryControl;
    this.getLifecycle = options.getLifecycle;
    this.adapter = options.adapter;
    this.continuationControl = new TerminalOutputV3ContinuationControl({
      ingress: this.ingress,
      deliveryControl: this.deliveryControl,
      isFailStopped: () => this.failure !== undefined,
      failStop: (reason) => this.failStop(reason),
      startEnvelope: (envelope, now) => this.startEnvelope(envelope, now),
    });
  }

  get activeGrantId(): string | null {
    return this.continuationControl.activeGrantId;
  }

  get failStoppedReason(): string | null {
    return this.failure?.reason ?? null;
  }

  get rememberedEnvelopeCount(): number {
    return this.ledger.size;
  }

  get hasUnsettledDelivery(): boolean {
    return this.unsettledDeliveryCount > 0;
  }

  matchKnownEnvelope(envelope: TerminalOutputEnvelope): TerminalOutputV3KnownEnvelopeMatch {
    return this.ledger.match(envelope);
  }

  hasKnownRepairIdentity(identity: TerminalOutputV3RepairIdentity): boolean {
    return this.ledger.hasRepairIdentity(identity);
  }

  stop(reason: string): Extract<TerminalOutputV3SurfaceResult, { kind: "fail-stop" }> {
    return this.failStop(reason);
  }

  receive(value: unknown, now: number): Promise<TerminalOutputV3SurfaceResult> {
    if (this.failure) return Promise.resolve(this.failure);

    let envelope: TerminalOutputEnvelope;
    try {
      envelope = normalizeTerminalOutputEnvelope(value);
    } catch {
      return Promise.resolve(this.failStop("invalid_envelope"));
    }

    return this.receiveValidated(envelope, now);
  }

  receiveValidated(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> {
    if (this.failure) return Promise.resolve(this.failure);

    const surfaceFailure = this.surfaceFailure();
    if (surfaceFailure) return Promise.resolve(this.failStop(`surface:${surfaceFailure}`));
    const existing = this.ledger.lookup(envelope);
    if (existing.kind === "conflict") {
      return Promise.resolve(this.failStop("envelope_identity_conflict"));
    }
    if (existing.kind === "same") {
      return existing.value;
    }

    const closingAdmission = this.continuationControl.admitDuringClose(envelope, now);
    if (closingAdmission) return closingAdmission;
    const openingAdmission = this.continuationControl.admitDuringOpen(envelope, now);
    if (openingAdmission) return openingAdmission;
    if (this.continuationControl.admitAfterClose(envelope)) {
      return this.startEnvelope(envelope, now);
    }
    if (envelope.grantId !== this.continuationControl.activeGrantId) {
      return Promise.resolve(this.failStop("grant_mismatch"));
    }

    // A null-grant successor consumed the one-envelope old-grant grace after
    // a settled close. Do not let a later stale event inherit that grace.
    this.continuationControl.clearSettledCloseGrant();

    return this.startEnvelope(envelope, now);
  }

  private startEnvelope(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> {
    this.unsettledDeliveryCount += 1;
    const promise = this.processEnvelope(envelope, now);
    const settleDelivery = () => {
      this.unsettledDeliveryCount -= 1;
    };
    void promise.then(settleDelivery, settleDelivery);
    this.ledger.remember(envelope, promise);
    return promise;
  }

  async flushExpired(now: number): Promise<void> {
    if (this.failure) return;
    const surfaceFailure = this.surfaceFailure();
    if (surfaceFailure) {
      this.failStop(`surface:${surfaceFailure}`);
      return;
    }

    let transitions: readonly TerminalOutputFrameContinuationTransition[];
    try {
      transitions = this.continuation.flushExpired(now);
    } catch {
      this.failStop("continuation_failure");
      return;
    }
    const controls = this.continuationControl.controlsForTransitions(transitions, null);
    if (!controls || controls.length === 0 || this.failure) return;
    this.unsettledDeliveryCount += 1;
    try {
      await this.continuationControl.sendControls(controls);
    } finally {
      this.unsettledDeliveryCount -= 1;
    }
  }

  private async processEnvelope(
    preflightEnvelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> {
    let preflight: ReturnType<TerminalOutputV3SurfaceAdapter["preflight"]>;
    try {
      preflight = this.adapter.preflight(preflightEnvelope);
    } catch {
      return this.failStop("preflight:error");
    }
    if (isThenable(preflight)) return this.failStop("preflight:async");
    if (preflight.kind === "rejected") {
      return this.failStop(`preflight:${preflight.reason}`);
    }

    let envelope: TerminalOutputEnvelope;
    try {
      envelope = this.ingress.acceptValidated(preflightEnvelope);
    } catch (error) {
      const reason =
        error instanceof TerminalOutputEnvelopeIngressError ? error.code : "admission_failure";
      return this.failStop(`ingress:${reason}`);
    }

    const surfaceFailure = this.surfaceFailure();
    if (surfaceFailure) return this.failStop(`surface:${surfaceFailure}`);

    let transitions: readonly TerminalOutputFrameContinuationTransition[];
    try {
      const observation = this.continuation.observe({
        data: envelope.backing,
        sourceStartSeq: envelope.seqStart,
        envelopeId: envelope.envelopeId,
        healthyLiveSurface: true,
        now,
      });
      if (observation.forward !== envelope.backing) {
        return this.failStop("continuation_backing_replaced");
      }
      transitions = observation.transitions;
    } catch {
      return this.failStop("continuation_gap");
    }

    const transitionControls = this.continuationControl.controlsForTransitions(
      transitions,
      envelope.envelopeId,
    );
    if (!transitionControls || this.failure) return this.failure ?? this.failStop("grant_mismatch");

    const completion: CompletionRecord = {
      envelope,
      transferred: false,
      transitionsSettled: transitionControls.length === 0,
      received: false,
    };
    let transferResult: ReturnType<TerminalOutputV3SurfaceAdapter["transfer"]>;
    try {
      transferResult = this.adapter.transfer({
        envelope,
        complete: (value) => this.receiveCompletion(completion, value),
      });
    } catch {
      return this.failStop("partial_transfer");
    }
    if (
      isThenable(transferResult) ||
      !Number.isInteger(transferResult.acceptedDeltaCount) ||
      transferResult.acceptedDeltaCount !== envelope.deltas.length
    ) {
      return this.failStop("partial_transfer");
    }

    completion.transferred = true;
    this.completePendingEnvelope(completion);
    if (this.failure) return this.failure;

    // Start continuation controls before the receipt, but do not put their IPC
    // round trip on the transport-credit path. Rust records the exact accepted
    // receipt so a hold/close that lands just after it still validates against
    // the immutable envelope boundary.
    const transitionCompletion =
      transitionControls.length > 0
        ? this.continuationControl.sendControls(transitionControls)
        : undefined;

    const receiptRequest: TerminalOutputDeliveryControlRequest = {
      identity: {
        kind: "receipt",
        terminalId: this.ingress.terminalId,
        generation: envelope.generation,
        leaseToken: envelope.leaseToken,
        envelopeId: envelope.envelopeId,
        grantId: envelope.grantId,
      },
      payload: { seqEnd: envelope.seqEnd },
    };
    // Transfer owns the backing synchronously. Release the local transport slot
    // immediately before starting the backend receipt: Rust may process that
    // invoke, emit the next envelope, and only then settle this Promise.
    const receiptCompletion = this.ingress.completeReceipt({
      terminalId: this.ingress.terminalId,
      generation: envelope.generation,
      leaseToken: envelope.leaseToken,
      envelopeId: envelope.envelopeId,
      grantId: envelope.grantId,
    });
    if (receiptCompletion !== "accepted") return this.failStop("receipt_completion_stale");
    const receiptResult = await this.deliveryControl.send(receiptRequest);
    if (this.failure) return this.failure;
    if (receiptResult.kind !== "accepted") {
      return this.failStop(controlFailureReason(receiptRequest, receiptResult));
    }

    if (transitionCompletion) {
      await transitionCompletion;
      if (this.failure) return this.failure;
      completion.transitionsSettled = true;
      this.completePendingEnvelope(completion);
    }

    this.continuationControl.completeReceipt(envelope.envelopeId);

    if (this.failure) return this.failure;
    return { kind: "accepted", envelopeId: envelope.envelopeId };
  }

  private receiveCompletion(
    record: CompletionRecord,
    completion: TerminalOutputV3EnvelopeCompletion,
  ): void {
    if (record.received || this.failure) return;
    record.received = true;
    // Surface loss and an invalid parser intersection are terminal facts, not
    // parsed-credit progress. Report them immediately even while a hold/close
    // bridge is pending; only a valid parsed ACK must wait behind transitions.
    if (
      completion.kind === "discarded" ||
      completion.visibleSeq !== record.envelope.seqEnd ||
      completion.checkpointSeq !== record.envelope.seqEnd
    ) {
      this.completeEnvelope(record, completion);
      return;
    }
    if (!record.transferred || !record.transitionsSettled) {
      record.pending = completion;
      return;
    }
    this.completeEnvelope(record, completion);
  }

  private completePendingEnvelope(record: CompletionRecord): void {
    if (!record.transferred || !record.transitionsSettled || !record.pending) return;
    const pending = record.pending;
    record.pending = undefined;
    this.completeEnvelope(record, pending);
  }

  private completeEnvelope(
    record: CompletionRecord,
    completion: TerminalOutputV3EnvelopeCompletion,
  ): void {
    if (this.failure) return;
    const surfaceFailure = this.surfaceFailure();
    if (surfaceFailure) {
      this.failStop(`surface:${surfaceFailure}`);
      return;
    }
    if (completion.kind === "discarded") {
      this.failStop(`discarded:${completion.reason}`);
      return;
    }

    const envelope = record.envelope;
    if (completion.visibleSeq !== envelope.seqEnd || completion.checkpointSeq !== envelope.seqEnd) {
      this.failStop("partial_parser_completion");
      return;
    }
    if (this.ingress.parsedSeq !== envelope.seqStart) {
      this.failStop("parsed_gap");
      return;
    }

    const identity: TerminalOutputParsedIdentity = {
      terminalId: this.ingress.terminalId,
      generation: envelope.generation,
      leaseToken: envelope.leaseToken,
      seq: envelope.seqEnd,
    };
    let completionResult: ReturnType<TerminalOutputEnvelopeIngress["completeParsed"]>;
    try {
      completionResult = this.ingress.completeParsed(identity);
    } catch {
      this.failStop("parsed_gap");
      return;
    }
    if (completionResult !== "accepted") {
      this.failStop("parsed_completion_stale");
      return;
    }

    let ack: Promise<boolean>;
    try {
      ack = Promise.resolve(this.adapter.sendParsedAck(identity));
    } catch {
      this.failStop("parsed_ack_rejected");
      return;
    }
    void ack.then(
      (accepted) => {
        if (this.failure) return;
        const lateSurfaceFailure = this.surfaceFailure();
        if (lateSurfaceFailure) {
          this.failStop(`surface:${lateSurfaceFailure}`);
        } else if (!accepted) {
          this.failStop("parsed_ack_rejected");
        }
      },
      () => {
        if (!this.failure) this.failStop("parsed_ack_rejected");
      },
    );
  }

  private surfaceFailure(): string | undefined {
    let lifecycle: TerminalOutputSurfaceLifecycle;
    try {
      lifecycle = this.getLifecycle();
    } catch {
      return "lifecycle_unavailable";
    }
    if (
      lifecycle.generation !== this.ingress.generation ||
      lifecycle.leaseToken !== this.ingress.leaseToken
    ) {
      return "session_stale";
    }
    const availability = terminalOutputSurfaceAvailability(lifecycle);
    return availability.kind === "unavailable" ? availability.reason : undefined;
  }

  private failStop(reason: string): Extract<TerminalOutputV3SurfaceResult, { kind: "fail-stop" }> {
    if (this.failure) return this.failure;
    this.failure = Object.freeze({ kind: "fail-stop", reason });
    this.continuationControl.failPending(this.failure);
    this.deliveryControl.dispose();
    try {
      this.adapter.failStop(reason);
    } catch {
      // Diagnostics cannot reopen a stopped surface.
    }
    return this.failure;
  }
}

function controlFailureReason(
  request: TerminalOutputDeliveryControlRequest,
  result: Exclude<TerminalOutputDeliveryControlResult, { kind: "accepted" }>,
): string {
  const detail = result.kind === "fail-stop" ? result.reason : result.kind;
  return `control:${request.identity.kind}:${detail}`;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
