import type {
  TerminalOutputDeliveryControlRequest,
  TerminalOutputDeliveryControlResult,
  TerminalOutputDeliveryControlSender,
} from "./terminal-output-delivery-control";
import type { TerminalOutputEnvelope } from "./terminal-output-envelope";
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

interface ClosingGrant {
  grant: TerminalOutputFrameContinuationGrant;
  envelopeId: number;
  closeAccepted: boolean;
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
  startEnvelope(
    envelope: TerminalOutputEnvelope,
    now: number,
  ): Promise<TerminalOutputV3SurfaceResult>;
}

/** Owns active/closing continuation identity and its single gated successor. */
export class TerminalOutputV3ContinuationControl {
  private grant: TerminalOutputFrameContinuationGrant | undefined;
  private closing: ClosingGrant | undefined;
  private pending: ClosingPendingEnvelope | undefined;
  /** A frame opened inside the envelope that closes the prior continuation. */
  private suppressedGrantId: string | undefined;
  /**
   * The single successor can be emitted with the old grant after the close
   * and receipt responses have both settled. Keep that identity only until
   * the next contiguous envelope is admitted.
   */
  private settledCloseGrant: TerminalOutputFrameContinuationGrant | undefined;
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
    if (!oldGrantSuccessor && !nullGrantSuccessor) {
      return Promise.resolve(this.options.failStop("grant_mismatch"));
    }
    if (envelope.envelopeId !== ingress.expectedEnvelopeId) {
      return Promise.resolve(this.options.failStop("ingress:envelope-order"));
    }
    if (envelope.seqStart !== ingress.admittedSeq) {
      return Promise.resolve(this.options.failStop("ingress:sequence"));
    }

    if (this.pending) {
      if (!sameTerminalOutputEnvelope(this.pending.envelope, envelope)) {
        return Promise.resolve(this.options.failStop("envelope_identity_conflict"));
      }
      return this.pending.promise;
    }
    let resolve!: (result: TerminalOutputV3SurfaceResult) => void;
    const promise = new Promise<TerminalOutputV3SurfaceResult>((settle) => {
      resolve = settle;
    });
    this.pending = { envelope, now, promise, resolve };
    return promise;
  }

  admitAfterClose(envelope: TerminalOutputEnvelope): boolean {
    const settledCloseGrant = this.settledCloseGrant;
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
    this.settledCloseGrant = undefined;
    return true;
  }

  clearSettledCloseGrant(): void {
    this.settledCloseGrant = undefined;
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

  async sendControls(controls: readonly TerminalOutputDeliveryControlRequest[]): Promise<void> {
    const pending = controls.map((request) => ({
      request,
      result: this.options.deliveryControl.send(request),
    }));
    for (const control of pending) {
      const result = await control.result;
      if (this.options.isFailStopped()) return;
      if (result.kind !== "accepted") {
        this.options.failStop(controlFailureReason(control.request, result));
        return;
      }
      if (control.request.identity.kind === "close") this.acceptClose(control.request);
    }
  }

  completeReceipt(envelopeId: number): void {
    const closing = this.closing;
    if (!closing || closing.waitForReceiptEnvelopeId !== envelopeId) return;
    closing.waitForReceiptEnvelopeId = null;
    if (closing.closeAccepted) this.finishClose();
  }

  failPending(failure: Failure): void {
    const pending = this.pending;
    this.pending = undefined;
    this.closing = undefined;
    this.grant = undefined;
    this.heldEnvelopeId = undefined;
    this.settledCloseGrant = undefined;
    this.suppressedGrantId = undefined;
    pending?.resolve(failure);
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
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) {
      this.settledCloseGrant = closing.grant;
      return;
    }
    const processing = this.options.startEnvelope(pending.envelope, pending.now);
    void processing.then(pending.resolve, () =>
      pending.resolve(this.options.failStop("admission_failure")),
    );
  }
}

function controlFailureReason(
  request: TerminalOutputDeliveryControlRequest,
  result: Exclude<TerminalOutputDeliveryControlResult, { kind: "accepted" }>,
): string {
  const detail = result.kind === "fail-stop" ? result.reason : result.kind;
  return `control:${request.identity.kind}:${detail}`;
}
