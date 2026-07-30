import type { TerminalOutputControlMountScope } from "./terminal-output-control-registry";
import {
  TerminalOutputDeliveryControlSender,
  type ImmutableTerminalOutputDeliveryControlRequest,
} from "./terminal-output-delivery-control";
import {
  normalizeTerminalOutputEnvelope,
  type TerminalOutputEnvelope,
  type TerminalOutputEnvelopeDelta,
} from "./terminal-output-envelope";
import { TerminalOutputEnvelopeIngress } from "./terminal-output-envelope-ingress";
import { TerminalOutputFrameContinuationTracker } from "./terminal-output-frame-continuation";
import type { TerminalOutputSurfaceLifecycle } from "./terminal-output-surface-lifecycle";
import {
  TerminalOutputV3SurfaceController,
  type TerminalOutputV3SurfaceResult,
} from "./terminal-output-v3-surface-controller";
import { sameTerminalOutputEnvelope } from "./terminal-output-v3-envelope-ledger";
import {
  matchesTerminalOutputV3RepairRequest,
  TerminalOutputV3RepairState,
} from "./terminal-output-v3-repair-state";
import {
  TerminalOutputV3RepairTransport,
  type TerminalOutputV3RepairRequest,
  type TerminalOutputV3RepairResponse,
  type TerminalOutputV3Repairer,
} from "./terminal-output-v3-repair-transport";
import { TerminalOutputV3TerminalAdapter } from "./terminal-output-v3-terminal-adapter";
import {
  acknowledgeTerminalOutputEnvelope,
  closeTerminalOutputContinuation,
  holdTerminalOutputContinuation,
} from "./tauri-api";

export type {
  TerminalOutputV3RepairRequest,
  TerminalOutputV3RepairResponse,
  TerminalOutputV3RepairStatus,
} from "./terminal-output-v3-repair-transport";

export interface TerminalOutputV3RuntimeOptions {
  terminalId: string;
  generation: number;
  leaseToken: string;
  attachEpoch: number;
  initialSeq: number;
  initialEnvelopeId: number;
  controlTimeoutMs: number;
  scope: TerminalOutputControlMountScope;
  isCurrent(): boolean;
  getLifecycleFacts(): Pick<
    TerminalOutputSurfaceLifecycle,
    "disposed" | "failStoppedReason" | "stabilizerHolding" | "capacityWaiting"
  > & { parsersReady: boolean };
  applyCheckpoint(delta: TerminalOutputEnvelopeDelta): PromiseLike<void>;
  enqueueVisible(
    delta: TerminalOutputEnvelopeDelta,
    onParsed: (() => void) | undefined,
    onDiscard: (reason: string) => void,
  ): void;
  sendParsedRange(seqStart: number, seqEnd: number): Promise<boolean>;
  repairEnvelope?: TerminalOutputV3Repairer;
  onFailStop(reason: string): void;
}

export interface TerminalOutputV3RuntimeDiagnostics {
  admittedSeq: number;
  parsedSeq: number;
  nextEnvelopeId: number;
  activeGrantId: string | null;
  repairCount: number;
  lastRepairReason: string | null;
}

/** Dynamically loaded v3 owner; listener registration itself stays in the entry chunk. */
export class TerminalOutputV3Runtime {
  private readonly ingress: TerminalOutputEnvelopeIngress;
  private readonly continuation: TerminalOutputFrameContinuationTracker;
  private readonly sender: TerminalOutputDeliveryControlSender;
  private readonly adapter: TerminalOutputV3TerminalAdapter;
  private readonly controller: TerminalOutputV3SurfaceController;
  private readonly options: TerminalOutputV3RuntimeOptions;
  private readonly repairTransport: TerminalOutputV3RepairTransport;
  private readonly repairState = new TerminalOutputV3RepairState();
  private repairPromise: Promise<void> | undefined;
  private pendingObservedDrain: Promise<void> | undefined;
  private disposed = false;
  private repairCount = 0;
  private lastRepairReason: string | null = null;

  constructor(options: TerminalOutputV3RuntimeOptions) {
    this.options = options;
    this.repairTransport = new TerminalOutputV3RepairTransport(
      options.controlTimeoutMs,
      options.repairEnvelope,
    );
    this.ingress = new TerminalOutputEnvelopeIngress({
      terminalId: options.terminalId,
      generation: options.generation,
      leaseToken: options.leaseToken,
      initialSeq: options.initialSeq,
      initialEnvelopeId: options.initialEnvelopeId,
    });
    this.continuation = new TerminalOutputFrameContinuationTracker({
      surface: "active",
      terminalId: options.terminalId,
      generation: options.generation,
      leaseToken: options.leaseToken,
      timeoutMs: options.controlTimeoutMs,
    });
    this.sender = new TerminalOutputDeliveryControlSender({
      scope: options.scope,
      invoke: invokeControl,
      isCurrent: (request) =>
        options.isCurrent() &&
        request.identity.generation === options.generation &&
        request.identity.leaseToken === options.leaseToken,
      timeoutMs: options.controlTimeoutMs,
    });
    this.adapter = new TerminalOutputV3TerminalAdapter({
      terminalId: options.terminalId,
      generation: options.generation,
      leaseToken: options.leaseToken,
      initialParsedSeq: options.initialSeq,
      isCurrent: () => this.isCurrent(),
      applyCheckpoint: options.applyCheckpoint,
      enqueueVisible: options.enqueueVisible,
      sendParsedRange: options.sendParsedRange,
      onFailStop: options.onFailStop,
    });
    this.controller = new TerminalOutputV3SurfaceController({
      ingress: this.ingress,
      continuation: this.continuation,
      deliveryControl: this.sender,
      getLifecycle: () => {
        const facts = options.getLifecycleFacts();
        const parser = {
          alive: !facts.disposed,
          ready: facts.parsersReady,
          generation: options.generation,
          leaseToken: options.leaseToken,
        };
        return {
          generation: options.generation,
          leaseToken: options.leaseToken,
          attachEpoch: options.attachEpoch,
          visible: parser,
          checkpoint: { ...parser },
          disposed: facts.disposed,
          failStoppedReason: facts.failStoppedReason,
          stabilizerHolding: facts.stabilizerHolding,
          capacityWaiting: facts.capacityWaiting,
        };
      },
      adapter: this.adapter,
    });
  }

  async receive(payload: unknown, now: number): Promise<TerminalOutputV3SurfaceResult> {
    if (!this.isCurrent()) return staleRuntimeResult();
    if (this.controller.failStoppedReason) {
      const result: TerminalOutputV3SurfaceResult = {
        kind: "fail-stop",
        reason: this.controller.failStoppedReason,
      };
      this.settlePending(result);
      return result;
    }

    let envelope: TerminalOutputEnvelope;
    try {
      envelope = normalizeTerminalOutputEnvelope(payload);
    } catch {
      const result = await this.controller.receive(payload, now);
      if (result.kind === "fail-stop") this.settlePending(result);
      return result;
    }

    if (
      envelope.generation !== this.ingress.generation ||
      envelope.leaseToken !== this.ingress.leaseToken
    ) {
      return staleRuntimeResult();
    }

    const winner = this.repairState.observeWinner(envelope);
    if (winner === "conflict") return this.failRepair("winner_conflict");
    if (winner === "duplicate") {
      return { kind: "accepted", envelopeId: envelope.envelopeId };
    }

    const ingress = this.ingress.snapshot();
    if (
      envelope.envelopeId === ingress.expectedEnvelopeId &&
      envelope.seqStart === ingress.admittedSeq
    ) {
      const result = await this.controller.receiveValidated(envelope, now);
      if (result.kind === "fail-stop") {
        this.settlePending(result);
        return result;
      }
      await this.drainPendingObserved(true);
      return result;
    }

    if (envelope.envelopeId < ingress.expectedEnvelopeId) {
      const result = await this.controller.receiveValidated(envelope, now);
      if (result.kind === "fail-stop") this.settlePending(result);
      return result;
    }

    return this.queueObservedGap(envelope, now);
  }

  flushExpired(now: number): Promise<void> {
    return this.controller.flushExpired(now);
  }

  get continuationDeadline(): number | undefined {
    return this.continuation.deadline;
  }

  async pollExactRepair(now: number): Promise<TerminalOutputV3SurfaceResult | undefined> {
    if (!this.isCurrent() || this.controller.hasUnsettledDelivery) return undefined;
    await this.startRepair("watchdog", now);
    return this.controller.failStoppedReason
      ? { kind: "fail-stop", reason: this.controller.failStoppedReason }
      : undefined;
  }

  diagnostics(): TerminalOutputV3RuntimeDiagnostics {
    const ingress = this.ingress.snapshot();
    return {
      admittedSeq: ingress.admittedSeq,
      parsedSeq: ingress.parsedSeq,
      nextEnvelopeId: ingress.expectedEnvelopeId,
      activeGrantId: this.controller.activeGrantId,
      repairCount: this.repairCount,
      lastRepairReason: this.lastRepairReason,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.repairState.clearActive();
    this.repairTransport.dispose();
    this.settlePending(staleRuntimeResult());
    this.adapter.dispose();
    this.sender.dispose();
  }

  private queueObservedGap(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> {
    const admission = this.repairState.queueObserved(envelope, now);
    if (admission.kind === "conflict") {
      return Promise.resolve(this.failRepair("observed_conflict"));
    }
    if (admission.kind === "queued") void this.startRepair("event-gap", now);
    return admission.promise;
  }

  private async startRepair(reason: "event-gap" | "watchdog", now: number): Promise<void> {
    if (
      !this.isCurrent() ||
      this.controller.failStoppedReason ||
      this.controller.hasUnsettledDelivery ||
      this.repairPromise
    ) {
      return this.repairPromise;
    }

    const ingress = this.ingress.snapshot();
    const request: TerminalOutputV3RepairRequest = Object.freeze({
      terminalId: this.ingress.terminalId,
      generation: this.ingress.generation,
      token: this.ingress.leaseToken,
      envelopeId: ingress.expectedEnvelopeId,
      grantId: this.controller.activeGrantId,
      seqStart: ingress.admittedSeq,
    });
    const active = this.repairState.begin(request);
    const attempt = this.runRepair(request, reason, now);
    this.repairPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.repairPromise === attempt) this.repairPromise = undefined;
      this.repairState.finish(active);
    }
  }

  private async runRepair(
    request: Readonly<TerminalOutputV3RepairRequest>,
    reason: "event-gap" | "watchdog",
    now: number,
  ): Promise<void> {
    const outcome = await this.repairTransport.wait(request);
    if (outcome.kind === "stale") return;
    if (!this.isCurrent()) return;
    if (outcome.kind === "rejected" || outcome.kind === "timeout") {
      this.failRepair(outcome.kind === "timeout" ? "timeout" : "invoke");
      return;
    }
    const response = outcome.response;
    if (!isRepairResponse(response)) {
      this.failRepair("malformed_response");
      return;
    }
    if (response.status === "idle") return;
    if (response.status === "alreadyReceipted") {
      const witness = this.repairState.witness(request);
      if (witness) return;
      const known = this.controller.hasKnownRepairIdentity({
        generation: request.generation,
        leaseToken: request.token,
        envelopeId: request.envelopeId,
        grantId: request.grantId,
        seqStart: request.seqStart,
      });
      const ingress = this.ingress.snapshot();
      if (
        !known ||
        ingress.expectedEnvelopeId !== request.envelopeId + 1 ||
        ingress.admittedSeq <= request.seqStart
      ) {
        this.failRepair("already_receipted_unknown");
        return;
      }
      await this.drainPendingObserved(true);
      return;
    }
    if (response.status !== "exact") {
      this.failRepair(response.status);
      return;
    }

    let exact: TerminalOutputEnvelope;
    try {
      exact = normalizeTerminalOutputEnvelope(response.envelope);
    } catch {
      this.failRepair("malformed_exact");
      return;
    }
    if (!matchesTerminalOutputV3RepairRequest(exact, request)) {
      this.failRepair("exact_identity_mismatch");
      return;
    }

    const witness = this.repairState.witness(request);
    if (witness) {
      if (!sameTerminalOutputEnvelope(witness, exact)) this.failRepair("winner_conflict");
      return;
    }

    const appliesRepair = this.controller.matchKnownEnvelope(exact) === "unknown";
    const result = await this.controller.receiveValidated(exact, now);
    if (!this.isCurrent()) return;
    if (result.kind === "fail-stop") {
      this.settlePending(result);
      return;
    }
    if (appliesRepair) {
      this.repairCount += 1;
      this.lastRepairReason = `${reason}:exact`;
    }
    await this.drainPendingObserved(true);
  }

  private drainPendingObserved(strict: boolean): Promise<void> {
    if (this.pendingObservedDrain) return this.pendingObservedDrain;
    const drain = this.drainPendingObservedNow(strict);
    const tracked = drain.finally(() => {
      if (this.pendingObservedDrain === tracked) this.pendingObservedDrain = undefined;
    });
    this.pendingObservedDrain = tracked;
    return tracked;
  }

  private async drainPendingObservedNow(strict: boolean): Promise<void> {
    while (this.isCurrent()) {
      const pending = this.repairState.pending;
      if (!pending) return;
      const ingress = this.ingress.snapshot();
      const isSuccessor =
        pending.envelope.envelopeId === ingress.expectedEnvelopeId &&
        pending.envelope.seqStart === ingress.admittedSeq;
      const match = this.controller.matchKnownEnvelope(pending.envelope);
      if (!isSuccessor && match !== "same") {
        if (
          match === "unknown" &&
          this.controller.hasDeferredEnvelope(ingress.expectedEnvelopeId, ingress.admittedSeq)
        ) {
          return;
        }
        if (strict) this.failRepair(match === "conflict" ? "observed_conflict" : "non_successor");
        return;
      }

      if (!this.repairState.detachPending(pending)) continue;
      const result = await this.controller.receiveValidated(pending.envelope, pending.now);
      pending.resolve(result);
      if (result.kind === "fail-stop") {
        this.settlePending(result);
        return;
      }
    }
  }

  private failRepair(
    reason: string,
  ): Extract<TerminalOutputV3SurfaceResult, { kind: "fail-stop" }> {
    this.lastRepairReason = `fail-stop:${reason}`;
    const result = this.controller.stop(`repair:${reason}`);
    this.settlePending(result);
    return result;
  }

  private settlePending(result: TerminalOutputV3SurfaceResult): void {
    this.repairState.settlePending(result);
  }

  private isCurrent(): boolean {
    return !this.disposed && this.options.isCurrent();
  }
}

function isRepairResponse(value: unknown): value is TerminalOutputV3RepairResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "idle" ||
      value.status === "exact" ||
      value.status === "stale" ||
      value.status === "alreadyReceipted" ||
      value.status === "mismatch" ||
      value.status === "exhausted")
  );
}

function staleRuntimeResult(): TerminalOutputV3SurfaceResult {
  return { kind: "stale" };
}

function invokeControl(request: ImmutableTerminalOutputDeliveryControlRequest): Promise<boolean> {
  const identity = request.identity;
  if ("seqEnd" in request.payload) {
    return acknowledgeTerminalOutputEnvelope(
      identity.terminalId,
      identity.generation,
      identity.leaseToken,
      identity.envelopeId,
      identity.grantId,
      request.payload.seqEnd,
    );
  }
  if ("frameStartSeq" in request.payload) {
    if (identity.grantId === null) return Promise.resolve(false);
    return holdTerminalOutputContinuation(
      identity.terminalId,
      identity.generation,
      identity.leaseToken,
      identity.envelopeId,
      identity.grantId,
      request.payload.frameStartSeq,
    );
  }
  if (identity.grantId === null) return Promise.resolve(false);
  return closeTerminalOutputContinuation(
    identity.terminalId,
    identity.generation,
    identity.leaseToken,
    identity.envelopeId,
    identity.grantId,
    request.payload.closeSeq,
    request.payload.reason,
  );
}
