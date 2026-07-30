import type {
  TerminalOutputAttachFailStoppedPayload,
  TerminalOutputSurfaceFailStoppedPayload,
  TerminalOutputSurfaceFailStopReason,
} from "./tauri-api";

interface SurfaceIdentity {
  generation: number;
  leaseToken: string;
}

/** Owns the one-shot frontend report and backend fail-stop identity filter. */
export class TerminalOutputV3FailureCoordinator {
  private identity: SurfaceIdentity | undefined;
  private pendingLocalReason: string | undefined;
  private bufferedBackendFailure: TerminalOutputSurfaceFailStoppedPayload | undefined;
  private reportStarted = false;

  constructor(
    private readonly terminalId: string,
    private readonly publish: (
      id: string,
      generation: number,
      token: string,
      reason: TerminalOutputSurfaceFailStopReason,
    ) => Promise<boolean>,
  ) {}

  bindIdentity(generation: number, leaseToken: string): string | undefined {
    this.identity = { generation, leaseToken };
    if (this.pendingLocalReason) this.reportLocal(this.pendingLocalReason);
    const buffered = this.bufferedBackendFailure;
    this.bufferedBackendFailure = undefined;
    return buffered ? this.receiveBackend(buffered) : undefined;
  }

  bindFailedAttach(failure: TerminalOutputAttachFailStoppedPayload): string | undefined {
    if (
      failure.terminalId !== this.terminalId ||
      !Number.isSafeInteger(failure.generation) ||
      failure.generation <= 0 ||
      typeof failure.reason !== "string" ||
      failure.reason.length === 0
    ) {
      return undefined;
    }
    // The typed attach result comes from the current id-scoped backend lookup
    // and is authoritative even when a buffered listener-first notice belongs
    // to an older generation. Never echo an already-owned backend failure.
    this.identity = undefined;
    this.bufferedBackendFailure = undefined;
    this.pendingLocalReason = undefined;
    this.reportStarted = true;
    return `backend:${failure.reason}`;
  }

  reportLocal(reason: string): void {
    if (this.reportStarted) return;
    const identity = this.identity;
    if (!identity) {
      this.pendingLocalReason = reason;
      return;
    }
    this.reportStarted = true;
    this.pendingLocalReason = undefined;
    void this.publish(
      this.terminalId,
      identity.generation,
      identity.leaseToken,
      normalizeTerminalOutputSurfaceFailStopReason(reason),
    ).catch(() => {
      // Diagnostics publication cannot reset, replay, reattach, or reopen.
    });
  }

  receiveBackend(failure: TerminalOutputSurfaceFailStoppedPayload): string | undefined {
    if (failure.terminalId !== this.terminalId) return undefined;
    const identity = this.identity;
    if (!identity) {
      this.bufferedBackendFailure = failure;
      return undefined;
    }
    if (
      failure.generation !== identity.generation ||
      (failure.leaseToken !== null && failure.leaseToken !== identity.leaseToken)
    ) {
      return undefined;
    }
    // The backend is already the diagnostics SoT. Cleanup must not echo it.
    this.reportStarted = true;
    this.pendingLocalReason = undefined;
    return `backend:${failure.reason}`;
  }

  disposeSurface(): void {
    this.reportLocal("surface_disposed");
  }
}

export function normalizeTerminalOutputSurfaceFailStopReason(
  reason: string,
): TerminalOutputSurfaceFailStopReason {
  return reason === "control_orphan_cap" || reason.endsWith(":control_orphan_cap")
    ? "control_orphan_cap"
    : "surface_unavailable";
}
