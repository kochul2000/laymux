import {
  repairTerminalOutputEnvelope,
  type TerminalOutputEnvelopeRepairResponse,
  type TerminalOutputEnvelopeRepairStatus,
} from "./tauri-api";

export interface TerminalOutputV3RepairRequest {
  terminalId: string;
  generation: number;
  token: string;
  envelopeId: number;
  grantId: string | null;
  seqStart: number;
}

export type TerminalOutputV3RepairStatus = TerminalOutputEnvelopeRepairStatus;
export type TerminalOutputV3RepairResponse = TerminalOutputEnvelopeRepairResponse;
export type TerminalOutputV3Repairer = (
  request: Readonly<TerminalOutputV3RepairRequest>,
) => Promise<TerminalOutputV3RepairResponse>;

export type TerminalOutputV3RepairWaitOutcome =
  | { readonly kind: "response"; readonly response: TerminalOutputV3RepairResponse }
  | { readonly kind: "rejected" }
  | { readonly kind: "timeout" }
  | { readonly kind: "stale" };

/** Owns the one uncancellable bridge wait without owning output recovery. */
export class TerminalOutputV3RepairTransport {
  private cancelWait: (() => void) | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly repair: TerminalOutputV3Repairer = invokeRepair,
  ) {}

  wait(
    request: Readonly<TerminalOutputV3RepairRequest>,
  ): Promise<TerminalOutputV3RepairWaitOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: TerminalOutputV3RepairWaitOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelWait === cancel) this.cancelWait = undefined;
        resolve(outcome);
      };
      const cancel = () => finish({ kind: "stale" });
      const timer = setTimeout(() => finish({ kind: "timeout" }), this.timeoutMs);
      this.cancelWait = cancel;
      let invoked: Promise<TerminalOutputV3RepairResponse>;
      try {
        invoked = Promise.resolve(this.repair(request));
      } catch {
        finish({ kind: "rejected" });
        return;
      }
      void invoked.then(
        (response) => finish({ kind: "response", response }),
        () => finish({ kind: "rejected" }),
      );
    });
  }

  dispose(): void {
    this.cancelWait?.();
    this.cancelWait = undefined;
  }
}

function invokeRepair(
  request: Readonly<TerminalOutputV3RepairRequest>,
): Promise<TerminalOutputV3RepairResponse> {
  return repairTerminalOutputEnvelope(
    request.terminalId,
    request.generation,
    request.token,
    request.envelopeId,
    request.grantId,
    request.seqStart,
  );
}
