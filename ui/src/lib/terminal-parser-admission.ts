import type {
  TerminalWriteFairOwner,
  TerminalWriteFairTurnContext,
  TerminalWritePriorityResolver,
} from "./terminal-write-fair-scheduler";
import { TerminalWriteFairScheduler } from "./terminal-write-fair-scheduler";
import type { TerminalWritePriority } from "./terminal-write-fair-scheduler";
import {
  TERMINAL_WRITE_BATCH_MAX_BYTES,
  TERMINAL_WRITE_BATCH_MAX_PARTS,
  TERMINAL_WRITE_FAIR_QUANTUM_BYTES,
} from "./terminal-write-batch-queue";

/** Hard liveness bound for adjacent checkpoint callbacks sharing one lease. */
export const TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE = TERMINAL_WRITE_BATCH_MAX_PARTS;

export type TerminalParserLane = "visible" | "checkpoint";

export function terminalParserPriority(
  containerHidden: boolean,
  focused: boolean,
): TerminalWritePriority {
  if (containerHidden) return "background";
  return focused ? "focused" : "foreground";
}

type ActiveLane = {
  lane: TerminalParserLane;
  releaseGlobal: () => void;
  released: boolean;
  leaseBytesConsumed: number;
  leaseCallbacksConsumed: number;
  turnBytes: number;
};

export type TerminalParserTurnContext = TerminalWriteFairTurnContext & {
  /** Remaining byte budget in this pane's current global admission turn. */
  maxBytes: number;
};

export type TerminalParserTurn = (release: () => void, context: TerminalParserTurnContext) => void;

type PendingLane = {
  turn: TerminalParserTurn;
  requestedBytes?: number;
};

type HeldCheckpointLease = {
  releaseGlobal: () => void;
  leaseBytesConsumed: number;
  leaseCallbacksConsumed: number;
};

type CancelScheduledMacrotask = () => void;
type ScheduleCancelableMacrotask = (task: () => void) => CancelScheduledMacrotask;

function scheduleCancelableMacrotask(task: () => void): CancelScheduledMacrotask {
  const timer = setTimeout(task, 0);
  return () => clearTimeout(timer);
}

/**
 * Multiplexes one pane's visible and rendererless xterm parsers behind the
 * pane's single app-wide scheduling owner.
 */
export class TerminalParserAdmission {
  private readonly pending = new Map<TerminalParserLane, PendingLane>();
  private globalTurnPending = false;
  private active: ActiveLane | undefined;
  private heldCheckpointLease: HeldCheckpointLease | undefined;
  private cancelCheckpointRelease: CancelScheduledMacrotask | undefined;
  private lastGranted: TerminalParserLane | undefined;
  private disposed = false;

  constructor(
    private readonly scheduler: TerminalWriteFairScheduler,
    private readonly owner: TerminalWriteFairOwner,
    private readonly resolvePriority: TerminalWritePriorityResolver,
    private readonly scheduleMacrotask: ScheduleCancelableMacrotask = scheduleCancelableMacrotask,
  ) {}

  request(lane: TerminalParserLane, turn: TerminalParserTurn, requestedBytes?: number): void {
    if (this.disposed || this.pending.has(lane)) return;
    if (lane === "checkpoint" && this.tryContinueCheckpoint(turn, requestedBytes)) return;
    this.pending.set(lane, { turn, requestedBytes });
    // A visible sibling discovered during a checkpoint callback belongs to the
    // pane's next turn. Keep it pending while the current checkpoint turn uses
    // its remaining byte/callback budget; the held-lease edge below queues the
    // sibling if no checkpoint continuation appears.
    if (lane === "visible" && (this.active?.lane === "checkpoint" || this.heldCheckpointLease)) {
      return;
    }
    this.ensureGlobalTurn();
    if (this.heldCheckpointLease) this.releaseHeldCheckpointLease();
  }

  cancelPending(lane: TerminalParserLane): void {
    if (!this.pending.delete(lane)) return;
    if (this.pending.size === 0 && this.globalTurnPending) {
      this.scheduler.cancelPending(this.owner);
      this.globalTurnPending = false;
    }
  }

  cancel(lane: TerminalParserLane): void {
    this.cancelPending(lane);
    if (this.active?.lane === lane) this.release(this.active);
    if (lane === "checkpoint" && this.heldCheckpointLease) this.releaseHeldCheckpointLease();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    if (this.active) this.active.released = true;
    this.active = undefined;
    this.heldCheckpointLease = undefined;
    this.cancelScheduledCheckpointRelease();
    this.globalTurnPending = false;
    this.scheduler.cancel(this.owner);
  }

  private ensureGlobalTurn(): void {
    if (this.disposed || this.globalTurnPending || this.pending.size === 0) return;
    this.globalTurnPending = true;
    this.scheduler.request(
      this.owner,
      (releaseGlobal, context) => this.runGlobalTurn(releaseGlobal, context),
      this.resolvePriority,
    );
  }

  private runGlobalTurn(releaseGlobal: () => void, context: TerminalWriteFairTurnContext): void {
    this.globalTurnPending = false;
    if (this.disposed) {
      releaseGlobal();
      return;
    }
    const lane = this.selectLane();
    if (!lane) {
      releaseGlobal();
      return;
    }
    const pending = this.pending.get(lane);
    if (!pending) {
      releaseGlobal();
      return;
    }
    this.pending.delete(lane);
    this.lastGranted = lane;
    const maxBytes = this.turnLimit(context.contended);
    const active: ActiveLane = {
      lane,
      releaseGlobal,
      released: false,
      leaseBytesConsumed: 0,
      leaseCallbacksConsumed: 0,
      turnBytes: this.turnBytes(pending.requestedBytes, maxBytes),
    };
    this.active = active;
    const release = () => this.release(active);
    try {
      // A sibling lane belongs to the same pane share. Preserve the existing
      // 256 KiB sole-pane fast path; another pane owner is what makes a turn
      // globally contended and reduces both lanes to 64 KiB.
      pending.turn(release, { ...context, maxBytes });
    } catch (error) {
      release();
      if (this.heldCheckpointLease) this.releaseHeldCheckpointLease();
      throw error;
    }
  }

  private selectLane(): TerminalParserLane | undefined {
    const hasVisible = this.pending.has("visible");
    const hasCheckpoint = this.pending.has("checkpoint");
    if (hasVisible && hasCheckpoint) {
      return this.lastGranted === "visible" ? "checkpoint" : "visible";
    }
    if (hasVisible) return "visible";
    if (hasCheckpoint) return "checkpoint";
    return undefined;
  }

  private release(active: ActiveLane): void {
    if (active.released) return;
    active.released = true;
    active.leaseBytesConsumed += active.turnBytes;
    active.leaseCallbacksConsumed += 1;
    if (this.active === active) this.active = undefined;
    const checkpointTurnLimit = this.turnLimit(this.scheduler.hasPendingOtherOwner(this.owner));
    const canContinueCheckpoint =
      active.leaseBytesConsumed < checkpointTurnLimit &&
      active.leaseCallbacksConsumed < TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE;
    if (
      active.lane === "checkpoint" &&
      !this.disposed &&
      !this.pending.has("checkpoint") &&
      (this.pending.size === 0 || canContinueCheckpoint)
    ) {
      // The next Promise-chain operation becomes visible only in a microtask
      // after this callback. Hold the global lease through one host-task edge
      // so it can continue within the remaining byte quantum even when the
      // visible sibling is already pending for this pane's next turn.
      const held: HeldCheckpointLease = {
        releaseGlobal: active.releaseGlobal,
        leaseBytesConsumed: active.leaseBytesConsumed,
        leaseCallbacksConsumed: active.leaseCallbacksConsumed,
      };
      this.heldCheckpointLease = held;
      this.scheduleCheckpointRelease();
      return;
    }
    // Requeue while the global lease is still active. The scheduler then keeps
    // its macrotask yield between consecutive parser turns from the same pane.
    this.ensureGlobalTurn();
    active.releaseGlobal();
  }

  private tryContinueCheckpoint(turn: TerminalParserTurn, requestedBytes?: number): boolean {
    const held = this.heldCheckpointLease;
    if (!held || this.active || this.pending.has("checkpoint")) return false;
    const contended = this.scheduler.hasPendingOtherOwner(this.owner);
    const turnLimit = this.turnLimit(contended);
    const remainingBytes = turnLimit - held.leaseBytesConsumed;
    if (
      remainingBytes <= 0 ||
      held.leaseCallbacksConsumed >= TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE ||
      requestedBytes === undefined ||
      !Number.isSafeInteger(requestedBytes) ||
      requestedBytes < 0 ||
      requestedBytes > remainingBytes
    ) {
      return false;
    }

    this.heldCheckpointLease = undefined;
    this.cancelScheduledCheckpointRelease();
    const active: ActiveLane = {
      lane: "checkpoint",
      releaseGlobal: held.releaseGlobal,
      released: false,
      leaseBytesConsumed: held.leaseBytesConsumed,
      leaseCallbacksConsumed: held.leaseCallbacksConsumed,
      turnBytes: requestedBytes,
    };
    this.active = active;
    const release = () => this.release(active);
    try {
      turn(release, { contended, maxBytes: remainingBytes });
    } catch (error) {
      release();
      if (this.heldCheckpointLease) this.releaseHeldCheckpointLease();
      throw error;
    }
    return true;
  }

  private releaseHeldCheckpointLease(): void {
    const held = this.heldCheckpointLease;
    if (!held) return;
    this.heldCheckpointLease = undefined;
    this.cancelScheduledCheckpointRelease();
    this.ensureGlobalTurn();
    held.releaseGlobal();
  }

  private scheduleCheckpointRelease(): void {
    if (this.cancelCheckpointRelease) return;
    this.cancelCheckpointRelease = this.scheduleMacrotask(() => {
      this.cancelCheckpointRelease = undefined;
      if (this.heldCheckpointLease) this.releaseHeldCheckpointLease();
    });
  }

  private cancelScheduledCheckpointRelease(): void {
    const cancel = this.cancelCheckpointRelease;
    if (!cancel) return;
    this.cancelCheckpointRelease = undefined;
    cancel();
  }

  private turnLimit(contended: boolean): number {
    return contended ? TERMINAL_WRITE_FAIR_QUANTUM_BYTES : TERMINAL_WRITE_BATCH_MAX_BYTES;
  }

  private turnBytes(requestedBytes: number | undefined, maxBytes: number): number {
    if (requestedBytes === undefined || !Number.isFinite(requestedBytes)) return maxBytes;
    return Math.min(maxBytes, Math.max(0, Math.floor(requestedBytes)));
  }
}
