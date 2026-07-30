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

  controlsForTransitions(
    transitions: readonly TerminalOutputFrameContinuationTransition[],
    waitForReceiptEnvelopeId: number | null,
  ): TerminalOutputDeliveryControlRequest[] | undefined {
    const controls: TerminalOutputDeliveryControlRequest[] = [];
    for (const transition of transitions) {
      if (transition.type === "opened") {
        if (!transition.grant) continue;
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
        controls.push({
          identity: { kind: "hold", ...transition.grant },
          payload: { frameStartSeq: transition.frameStartSeq },
        });
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
    if (!pending) return;
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
