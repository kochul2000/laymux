import type {
  TerminalWriteFairOwner,
  TerminalWriteFairTurn,
  TerminalWriteFairTurnContext,
  TerminalWritePriorityResolver,
} from "./terminal-write-fair-scheduler";
import { TerminalWriteFairScheduler } from "./terminal-write-fair-scheduler";
import type { TerminalWritePriority } from "./terminal-write-fair-scheduler";

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
};

/**
 * Multiplexes one pane's visible and rendererless xterm parsers behind the
 * pane's single app-wide scheduling owner.
 */
export class TerminalParserAdmission {
  private readonly pending = new Map<TerminalParserLane, TerminalWriteFairTurn>();
  private globalTurnPending = false;
  private active: ActiveLane | undefined;
  private lastGranted: TerminalParserLane | undefined;
  private disposed = false;

  constructor(
    private readonly scheduler: TerminalWriteFairScheduler,
    private readonly owner: TerminalWriteFairOwner,
    private readonly resolvePriority: TerminalWritePriorityResolver,
  ) {}

  request(lane: TerminalParserLane, turn: TerminalWriteFairTurn): void {
    if (this.disposed || this.pending.has(lane)) return;
    this.pending.set(lane, turn);
    this.ensureGlobalTurn();
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    if (this.active) this.active.released = true;
    this.active = undefined;
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
    const turn = this.pending.get(lane);
    if (!turn) {
      releaseGlobal();
      return;
    }
    this.pending.delete(lane);
    this.lastGranted = lane;
    const active: ActiveLane = { lane, releaseGlobal, released: false };
    this.active = active;
    const release = () => this.release(active);
    try {
      // A sibling lane belongs to the same pane share. Preserve the existing
      // 256 KiB sole-pane fast path; another pane owner is what makes a turn
      // globally contended and reduces both lanes to 64 KiB.
      turn(release, context);
    } catch (error) {
      release();
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
    if (this.active === active) this.active = undefined;
    // Requeue while the global lease is still active. The scheduler then keeps
    // its macrotask yield between consecutive parser turns from the same pane.
    this.ensureGlobalTurn();
    active.releaseGlobal();
  }
}
