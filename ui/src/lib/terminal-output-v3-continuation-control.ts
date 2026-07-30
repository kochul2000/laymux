import type {
  TerminalOutputDeliveryControlRequest,
  TerminalOutputDeliveryControlResult,
  TerminalOutputDeliveryControlSender,
} from "./terminal-output-delivery-control";
import {
  TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT,
  type TerminalOutputEnvelope,
} from "./terminal-output-envelope";
import type { TerminalOutputEnvelopeIngress } from "./terminal-output-envelope-ingress";
import type {
  TerminalOutputFrameContinuationGrant,
  TerminalOutputFrameContinuationTransition,
} from "./terminal-output-frame-continuation";
import {
  noteTerminalOutputV3EnvelopePass,
  recordTerminalOutputV3ControlTrace,
} from "./terminal-output-v3-diagnostics";
import { sameTerminalOutputEnvelope } from "./terminal-output-v3-envelope-ledger";
import type { TerminalOutputV3SurfaceResult } from "./terminal-output-v3-surface-controller";

type Failure = Extract<TerminalOutputV3SurfaceResult, { kind: "fail-stop" }>;
/** Twice the backend pipeline cap; enough for one overlapping close chain. */
const CLOSED_GRANT_HISTORY_LIMIT = TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT * 2;

interface ClosingGrant {
  grant: TerminalOutputFrameContinuationGrant;
  envelopeId: number;
  closeAccepted: boolean;
  waitForReceiptEnvelopeId: number | null;
}

interface OpeningGrant {
  grant: TerminalOutputFrameContinuationGrant;
  holdAccepted: boolean;
  waitForReceiptEnvelopeId: number | null;
}

interface ClosingPendingEnvelope {
  envelope: TerminalOutputEnvelope;
  now: number;
  promise: Promise<TerminalOutputV3SurfaceResult>;
  resolve(result: TerminalOutputV3SurfaceResult): void;
}

interface Options {
  ingress: TerminalOutputEnvelopeIngress;
  deliveryControl: Pick<TerminalOutputDeliveryControlSender, "send">;
  isFailStopped(): boolean;
  failStop(reason: string): Failure;
  resumeEnvelope(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult>;
}

/** Owns active/closing continuation identity and bounded gated successors. */
export class TerminalOutputV3ContinuationControl {
  private grant: TerminalOutputFrameContinuationGrant | undefined;
  /** A hold has been sent but its backend completion has not settled yet. */
  private opening: OpeningGrant | undefined;
  private closing: ClosingGrant | undefined;
  /** Envelopes emitted while the opener receipt is still pending. */
  private openingPending: ClosingPendingEnvelope[] = [];
  /** The bounded successor set emitted before the close completion reached Rust. */
  private pending: ClosingPendingEnvelope[] = [];
  /** Preserves hold/close causality across asynchronously resumed envelopes. */
  private controlTail: Promise<void> | undefined;
  /** A frame opened inside the envelope that closes the prior continuation. */
  private suppressedGrantId: string | undefined;
  /**
   * A bounded receipt pipeline may already contain several successors from
   * overlapping closed grants. A null-grant envelope may have been frozen
   * before a later hold, so only bounded history eviction retires these ids.
   */
  private settledCloseGrants: TerminalOutputFrameContinuationGrant[] = [];
  /**
   * The envelope that already opened a backend continuation.
   *
   * The backend keys a hold by its opener envelope identity, so a second hold
   * carrying the same `envelopeId` with a different grant/frameStart is a
   * fail-stop (`hold identity was reused with different payload`). One envelope
   * can contain many frames, and `grant`/`closing` alone do not close that hole:
   * `finishClose()` clears them asynchronously, so a later frame in the *same*
   * envelope can find them already cleared and open a second continuation.
   * Tracking the envelope itself keeps the one-grant-per-envelope invariant
   * regardless of when the close response lands.
   */
  private heldEnvelopeId: number | undefined;

  constructor(private readonly options: Options) {}

  get activeGrantId(): string | null {
    return this.grant?.grantId ?? null;
  }

  hasDeferredEnvelope(envelopeId: number, seqStart: number): boolean {
    return [...this.openingPending, ...this.pending].some(
      (item) => item.envelope.envelopeId === envelopeId && item.envelope.seqStart === seqStart,
    );
  }

  admitDuringOpen(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> | undefined {
    const opening = this.opening;
    if (!opening) return undefined;
    // The backend may accept hold before this opener's receipt releases its
    // slot. With a multi-slot receipt pipeline, successors emitted in that
    // interval already carry the active grant; ones emitted before hold still
    // carry null. Both are contiguous and must wait for the opener receipt.
    if (
      envelope.grantId !== null &&
      envelope.grantId !== opening.grant.grantId &&
      !this.isSettledGrant(envelope.grantId)
    ) {
      return Promise.resolve(this.options.failStop("grant_mismatch"));
    }
    return this.queuePendingEnvelope(this.openingPending, envelope, now);
  }

  admitDuringClose(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> | undefined {
    const closing = this.closing;
    if (!closing) return undefined;
    const ingress = this.options.ingress;
    if (envelope.generation !== ingress.generation || envelope.leaseToken !== ingress.leaseToken) {
      return Promise.resolve(this.options.failStop("ingress:session-mismatch"));
    }
    const oldGrantSuccessor = envelope.grantId === closing.grant.grantId;
    // Rust clears its lease grant before its close invoke resolves. Its next
    // output event can therefore arrive with no grant while this close is
    // still awaiting that response. Keep the envelope gated until
    // `closeAccepted`, rather than treating that ordered successor as a
    // foreign grant.
    const nullGrantSuccessor = envelope.grantId === null;
    const earlierClosedGrantSuccessor = this.isSettledGrant(envelope.grantId);
    if (!oldGrantSuccessor && !nullGrantSuccessor && !earlierClosedGrantSuccessor) {
      return Promise.resolve(this.options.failStop("grant_mismatch"));
    }
    if (envelope.envelopeId !== ingress.expectedEnvelopeId) {
      return Promise.resolve(this.options.failStop("ingress:envelope-order"));
    }
    if (envelope.seqStart !== ingress.admittedSeq) {
      return Promise.resolve(this.options.failStop("ingress:sequence"));
    }

    return this.queuePendingEnvelope(this.pending, envelope, now);
  }

  admitAfterClose(envelope: TerminalOutputEnvelope): boolean {
    const settledCloseGrant = this.settledCloseGrants.find(
      (grant) => grant.grantId === envelope.grantId,
    );
    const ingress = this.options.ingress;
    if (
      !settledCloseGrant ||
      envelope.grantId !== settledCloseGrant.grantId ||
      envelope.generation !== ingress.generation ||
      envelope.leaseToken !== ingress.leaseToken ||
      envelope.envelopeId !== ingress.expectedEnvelopeId ||
      envelope.seqStart !== ingress.admittedSeq
    ) {
      return false;
    }
    return true;
  }

  controlsForTransitions(
    transitions: readonly TerminalOutputFrameContinuationTransition[],
    waitForReceiptEnvelopeId: number | null,
  ): TerminalOutputDeliveryControlRequest[] | undefined {
    const controls: TerminalOutputDeliveryControlRequest[] = [];
    const envelopePass = noteTerminalOutputV3EnvelopePass(
      this.options.ingress.terminalId,
      waitForReceiptEnvelopeId ?? -1,
    );
    const trace = (
      kind: "hold" | "close",
      envelopeId: number,
      grantId: string | null,
      seq: number,
    ) =>
      recordTerminalOutputV3ControlTrace(this.options.ingress.terminalId, {
        kind,
        envelopeId,
        grantId,
        seq,
        envelopePass,
      });
    for (const transition of transitions) {
      if (transition.type === "opened") {
        if (!transition.grant) continue;
        if (this.suppressedGrantId) {
          this.options.failStop("grant_mismatch");
          return undefined;
        }
        if (this.heldEnvelopeId === transition.grant.envelopeId) {
          // This envelope already opened a continuation. A later frame inside it
          // would reuse the same backend opener identity, so keep its bytes on
          // base credit and ignore its close, exactly like the closing-envelope
          // case below.
          this.suppressedGrantId = transition.grant.grantId;
          continue;
        }
        if (this.grant && this.closing?.grant.grantId === this.grant.grantId) {
          // A single v3 envelope has one backend grant identity. A new frame
          // that starts after this envelope closes the old grant cannot open
          // its own backend continuation until the next null-grant envelope,
          // so keep its bytes on base credit and ignore its later close.
          this.suppressedGrantId = transition.grant.grantId;
          continue;
        }
        if (
          this.grant ||
          transition.grant.terminalId !== this.options.ingress.terminalId ||
          transition.grant.generation !== this.options.ingress.generation ||
          transition.grant.leaseToken !== this.options.ingress.leaseToken
        ) {
          this.options.failStop("grant_mismatch");
          return undefined;
        }
        this.grant = transition.grant;
        this.opening = {
          grant: transition.grant,
          holdAccepted: false,
          waitForReceiptEnvelopeId,
        };
        this.heldEnvelopeId = transition.grant.envelopeId;
        controls.push({
          identity: { kind: "hold", ...transition.grant },
          payload: { frameStartSeq: transition.frameStartSeq },
        });
        trace(
          "hold",
          transition.grant.envelopeId,
          transition.grant.grantId,
          transition.frameStartSeq,
        );
        continue;
      }

      if (this.suppressedGrantId && this.suppressedGrantId === transition.grant?.grantId) {
        this.suppressedGrantId = undefined;
        continue;
      }
      if (!transition.grant) {
        if (this.grant) {
          this.options.failStop("grant_mismatch");
          return undefined;
        }
        continue;
      }
      if (!this.grant || this.grant.grantId !== transition.grant.grantId || this.closing) {
        this.options.failStop("grant_mismatch");
        return undefined;
      }
      this.closing = {
        grant: transition.grant,
        envelopeId: transition.envelopeId,
        closeAccepted: false,
        waitForReceiptEnvelopeId,
      };
      controls.push({
        identity: { kind: "close", ...transition.grant, envelopeId: transition.envelopeId },
        payload: {
          closeSeq: transition.frameEndSeq,
          reason: transition.grantResult === "abort" ? `abort:${transition.reason}` : "close",
        },
      });
      trace("close", transition.envelopeId, transition.grant.grantId, transition.frameEndSeq);
    }
    return controls;
  }

  sendControls(controls: readonly TerminalOutputDeliveryControlRequest[]): Promise<void> {
    const previous = this.controlTail;
    const task = previous
      ? previous.then(() => this.sendControlsNow(controls))
      : this.sendControlsNow(controls);
    this.controlTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async sendControlsNow(
    controls: readonly TerminalOutputDeliveryControlRequest[],
  ): Promise<void> {
    for (const request of controls) {
      const result = await this.options.deliveryControl.send(request);
      if (this.options.isFailStopped()) return;
      if (result.kind !== "accepted") {
        this.options.failStop(controlFailureReason(request, result));
        return;
      }
      if (request.identity.kind === "hold") this.acceptOpen(request);
      if (request.identity.kind === "close") this.acceptClose(request);
    }
  }

  completeReceipt(envelopeId: number): void {
    const opening = this.opening;
    if (opening && opening.waitForReceiptEnvelopeId === envelopeId) {
      opening.waitForReceiptEnvelopeId = null;
      this.finishOpen();
    }
    const closing = this.closing;
    if (!closing || closing.waitForReceiptEnvelopeId !== envelopeId) return;
    closing.waitForReceiptEnvelopeId = null;
    if (closing.closeAccepted) this.finishClose();
  }

  failPending(failure: Failure): void {
    const pending = [...this.openingPending, ...this.pending];
    this.openingPending = [];
    this.pending = [];
    this.opening = undefined;
    this.closing = undefined;
    this.grant = undefined;
    this.heldEnvelopeId = undefined;
    this.settledCloseGrants = [];
    this.suppressedGrantId = undefined;
    for (const item of pending) item.resolve(failure);
  }

  private queuePendingEnvelope(
    pending: ClosingPendingEnvelope[],
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult> {
    const existing = pending.find((item) => item.envelope.envelopeId === envelope.envelopeId);
    if (existing) {
      return sameTerminalOutputEnvelope(existing.envelope, envelope)
        ? existing.promise
        : Promise.resolve(this.options.failStop("envelope_identity_conflict"));
    }
    const previous = pending.at(-1)?.envelope;
    const expectedEnvelopeId = previous
      ? previous.envelopeId + 1
      : this.options.ingress.expectedEnvelopeId;
    const expectedSeq = previous ? previous.seqEnd : this.options.ingress.admittedSeq;
    if (envelope.envelopeId !== expectedEnvelopeId) {
      return Promise.resolve(this.options.failStop("ingress:envelope-order"));
    }
    if (envelope.seqStart !== expectedSeq) {
      return Promise.resolve(this.options.failStop("ingress:sequence"));
    }
    let resolve!: (result: TerminalOutputV3SurfaceResult) => void;
    const promise = new Promise<TerminalOutputV3SurfaceResult>((settle) => {
      resolve = settle;
    });
    pending.push({ envelope, now, promise, resolve });
    return promise;
  }

  private acceptOpen(request: TerminalOutputDeliveryControlRequest): void {
    const opening = this.opening;
    if (!opening || opening.grant.grantId !== request.identity.grantId) {
      this.options.failStop("grant_mismatch");
      return;
    }
    opening.holdAccepted = true;
    this.finishOpen();
  }

  private finishOpen(): void {
    const opening = this.opening;
    if (!opening || !opening.holdAccepted || opening.waitForReceiptEnvelopeId !== null) return;
    this.opening = undefined;
    this.startPending(this.openingPending.splice(0));
  }

  private acceptClose(request: TerminalOutputDeliveryControlRequest): void {
    const closing = this.closing;
    if (
      !closing ||
      closing.grant.grantId !== request.identity.grantId ||
      closing.envelopeId !== request.identity.envelopeId
    ) {
      this.options.failStop("grant_mismatch");
      return;
    }
    closing.closeAccepted = true;
    if (closing.waitForReceiptEnvelopeId === null) this.finishClose();
  }

  private finishClose(): void {
    const closing = this.closing;
    if (!closing || !closing.closeAccepted || closing.waitForReceiptEnvelopeId !== null) return;
    this.closing = undefined;
    this.grant = undefined;
    this.rememberSettledGrant(closing.grant);
    const pending = this.pending.splice(0);
    if (pending.length === 0) {
      return;
    }
    this.startPending(pending);
  }

  private startPending(pending: readonly ClosingPendingEnvelope[]): void {
    void this.drainPending(pending);
  }

  private async drainPending(pending: readonly ClosingPendingEnvelope[]): Promise<void> {
    let failure: Failure | undefined;
    for (const item of pending) {
      if (failure) {
        item.resolve(failure);
        continue;
      }
      try {
        // Re-enter through the surface gate. The prior control may have
        // created a new opening/closing transition, so directly starting the
        // next item would bypass that newer owner.
        const result = await this.options.resumeEnvelope(item.envelope, item.now);
        item.resolve(result);
        if (result.kind === "fail-stop") failure = result;
      } catch {
        failure = this.options.failStop("admission_failure");
        item.resolve(failure);
      }
    }
  }

  private isSettledGrant(grantId: string | null): boolean {
    return (
      grantId !== null && this.settledCloseGrants.some((grant) => grant.grantId === grantId)
    );
  }

  private rememberSettledGrant(grant: TerminalOutputFrameContinuationGrant): void {
    this.settledCloseGrants = this.settledCloseGrants.filter(
      (candidate) => candidate.grantId !== grant.grantId,
    );
    this.settledCloseGrants.push(grant);
    if (this.settledCloseGrants.length > CLOSED_GRANT_HISTORY_LIMIT) {
      this.settledCloseGrants.splice(
        0,
        this.settledCloseGrants.length - CLOSED_GRANT_HISTORY_LIMIT,
      );
    }
  }
}

function controlFailureReason(
  request: TerminalOutputDeliveryControlRequest,
  result: Exclude<TerminalOutputDeliveryControlResult, { kind: "accepted" }>,
): string {
  const detail = result.kind === "fail-stop" ? result.reason : result.kind;
  return `control:${request.identity.kind}:${detail}`;
}
