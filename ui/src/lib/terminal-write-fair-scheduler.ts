export interface TerminalWriteFairTurnContext {
  /** Another effect owner is already queued behind this granted turn. */
  contended: boolean;
}

export type TerminalWriteFairTurn = (
  release: () => void,
  context: TerminalWriteFairTurnContext,
) => void;
export type TerminalWriteFairOwner = symbol;

/** Create an identity token scoped to one TerminalView xterm effect lifetime. */
export function createTerminalWriteFairOwner(debugLabel?: string): TerminalWriteFairOwner {
  return Symbol(debugLabel);
}

type ScheduleMacrotask = (task: () => void) => void;

type ActiveTurn = {
  owner: TerminalWriteFairOwner;
  released: boolean;
};

/**
 * App-wide round-robin admission for physical xterm writes.
 *
 * A TerminalView keeps ownership of its byte FIFO and parse completion. This
 * scheduler owns only the scarce main-thread admission turn: one pane submits
 * one physical write, holds the turn through its parse callback, then returns
 * to the tail if it still has work. The next pane always starts in a fresh
 * macrotask so input, paint, and control work can run between turns.
 */
export class TerminalWriteFairScheduler {
  private readonly pendingTurns = new Map<TerminalWriteFairOwner, TerminalWriteFairTurn>();
  private pendingOwners: TerminalWriteFairOwner[] = [];
  private activeTurn: ActiveTurn | undefined;
  private macrotaskScheduled = false;
  private macrotaskGeneration = 0;

  constructor(
    private readonly scheduleMacrotask: ScheduleMacrotask = (task) => {
      setTimeout(task, 0);
    },
  ) {}

  /** Queue at most one future turn for a mounted terminal pane. */
  request(owner: TerminalWriteFairOwner, turn: TerminalWriteFairTurn): void {
    if (this.pendingTurns.has(owner)) return;
    this.pendingTurns.set(owner, turn);
    this.pendingOwners.push(owner);
    // Preserve the existing zero-backlog path: terminal.write admission itself
    // is cheap and xterm schedules parsing internally. Fairness is needed once a
    // pane already owns a parse or another pane is waiting.
    if (this.activeTurn === undefined && !this.macrotaskScheduled) {
      this.runNext();
      return;
    }
    this.scheduleNext();
  }

  /** Remove only a future turn while preserving an accepted active write. */
  cancelPending(owner: TerminalWriteFairOwner): void {
    if (!this.pendingTurns.delete(owner)) return;
    this.pendingOwners = this.pendingOwners.filter((pending) => pending !== owner);
    if (this.pendingTurns.size === 0 && this.activeTurn === undefined && this.macrotaskScheduled) {
      // The host timer API does not expose a common cancellation handle. Make
      // its callback stale instead, so a later idle request need not wait for it.
      this.macrotaskScheduled = false;
      this.macrotaskGeneration += 1;
    }
  }

  /**
   * Remove a pane's queued turn and release an in-flight scheduler lease.
   *
   * This does not cancel an xterm write that was already accepted. Its late
   * callback still owns the local FIFO outcome, while the idempotent release it
   * captured can no longer disturb a newer global turn.
   */
  cancel(owner: TerminalWriteFairOwner): void {
    this.cancelPending(owner);
    if (this.activeTurn?.owner === owner) this.release(this.activeTurn);
  }

  private scheduleNext(): void {
    if (this.activeTurn !== undefined || this.macrotaskScheduled || this.pendingTurns.size === 0) {
      return;
    }
    this.macrotaskScheduled = true;
    const generation = ++this.macrotaskGeneration;
    this.scheduleMacrotask(() => {
      if (generation !== this.macrotaskGeneration) return;
      this.macrotaskScheduled = false;
      this.runNext();
    });
  }

  private runNext(): void {
    if (this.activeTurn !== undefined) return;

    let owner: TerminalWriteFairOwner | undefined;
    let turn: TerminalWriteFairTurn | undefined;
    while ((owner = this.pendingOwners.shift()) !== undefined) {
      turn = this.pendingTurns.get(owner);
      if (turn !== undefined) break;
    }
    if (owner === undefined || turn === undefined) return;

    this.pendingTurns.delete(owner);
    const activeTurn: ActiveTurn = { owner, released: false };
    this.activeTurn = activeTurn;
    const release = () => this.release(activeTurn);
    try {
      turn(release, { contended: this.pendingTurns.size > 0 });
    } catch (error) {
      release();
      throw error;
    }
  }

  private release(turn: ActiveTurn): void {
    if (turn.released) return;
    turn.released = true;
    if (this.activeTurn === turn) this.activeTurn = undefined;
    this.scheduleNext();
  }
}

export const terminalWriteFairScheduler = new TerminalWriteFairScheduler();
