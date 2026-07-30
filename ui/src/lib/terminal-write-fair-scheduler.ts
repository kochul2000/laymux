export interface TerminalWriteFairTurnContext {
  /** Another effect owner is already queued behind this granted turn. */
  contended: boolean;
}

export type TerminalWriteFairTurn = (
  release: () => void,
  context: TerminalWriteFairTurnContext,
) => void;
export type TerminalWriteFairOwner = symbol;
export type TerminalWritePriority = "focused" | "foreground" | "background";
export type TerminalWritePriorityResolver = () => TerminalWritePriority;

const TERMINAL_WRITE_PRIORITY_WEIGHT: Record<TerminalWritePriority, number> = {
  focused: 4,
  foreground: 2,
  background: 1,
};

/** A waiting owner becomes urgent after this many other completed admissions. */
export const TERMINAL_WRITE_MAX_SKIPPED_TURNS = 8;

/** Create an identity token scoped to one TerminalView xterm effect lifetime. */
export function createTerminalWriteFairOwner(debugLabel?: string): TerminalWriteFairOwner {
  return Symbol(debugLabel);
}

type ScheduleMacrotask = (task: () => void) => void;

type ActiveTurn = {
  owner: TerminalWriteFairOwner;
  released: boolean;
};

type PendingTurn = {
  turn: TerminalWriteFairTurn;
  resolvePriority: TerminalWritePriorityResolver;
  skippedTurns: number;
};

/**
 * App-wide round-robin admission for physical xterm writes.
 *
 * A TerminalView keeps ownership of its byte FIFO and parse completion. This
 * scheduler owns only the scarce main-thread admission turn: one pane submits
 * one bounded parser quantum, holds the turn through its parse callback(s),
 * then returns to the tail if it still has work. The next pane always starts
 * in a fresh macrotask so input, paint, and control work can run between turns.
 */
export class TerminalWriteFairScheduler {
  private readonly pendingTurns = new Map<TerminalWriteFairOwner, PendingTurn>();
  private readonly balances = new Map<TerminalWriteFairOwner, number>();
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
  request(
    owner: TerminalWriteFairOwner,
    turn: TerminalWriteFairTurn,
    resolvePriority: TerminalWritePriorityResolver = () => "foreground",
  ): void {
    if (this.pendingTurns.has(owner)) return;
    this.pendingTurns.set(owner, { turn, resolvePriority, skippedTurns: 0 });
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
    if (!this.pendingTurns.delete(owner)) {
      if (this.activeTurn?.owner !== owner) this.balances.delete(owner);
      return;
    }
    this.balances.delete(owner);
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

  /** Test/diagnostic visibility without exposing mutable scheduler state. */
  isIdleForTests(): boolean {
    return (
      this.pendingTurns.size === 0 &&
      this.pendingOwners.length === 0 &&
      this.activeTurn === undefined &&
      !this.macrotaskScheduled
    );
  }

  /** Whether another pane owner is queued behind the current owner. */
  hasPendingOtherOwner(owner: TerminalWriteFairOwner): boolean {
    for (const pendingOwner of this.pendingTurns.keys()) {
      if (pendingOwner !== owner) return true;
    }
    return false;
  }

  /** Test-only isolation for the app-global scheduler fixture. */
  resetForTests(): void {
    if (this.activeTurn !== undefined) this.activeTurn.released = true;
    this.activeTurn = undefined;
    this.pendingTurns.clear();
    this.balances.clear();
    this.pendingOwners.length = 0;
    this.macrotaskScheduled = false;
    // Host timers have no shared cancellation API. Invalidate every callback
    // that was scheduled before this reset so it cannot enter the next test.
    this.macrotaskGeneration += 1;
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

    const owner = this.selectNextOwner();
    if (owner === undefined) return;
    const pending = this.pendingTurns.get(owner);
    if (pending === undefined) return;

    this.pendingTurns.delete(owner);
    const ownerIndex = this.pendingOwners.indexOf(owner);
    if (ownerIndex >= 0) this.pendingOwners.splice(ownerIndex, 1);
    for (const waiting of this.pendingTurns.values()) {
      waiting.skippedTurns = Math.min(TERMINAL_WRITE_MAX_SKIPPED_TURNS, waiting.skippedTurns + 1);
    }
    const activeTurn: ActiveTurn = { owner, released: false };
    this.activeTurn = activeTurn;
    const release = () => this.release(activeTurn);
    try {
      pending.turn(release, { contended: this.pendingTurns.size > 0 });
    } catch (error) {
      release();
      throw error;
    }
  }

  private selectNextOwner(): TerminalWriteFairOwner | undefined {
    const urgent = this.pendingOwners.find(
      (owner) =>
        (this.pendingTurns.get(owner)?.skippedTurns ?? 0) >= TERMINAL_WRITE_MAX_SKIPPED_TURNS,
    );
    if (urgent !== undefined) {
      this.balances.set(urgent, 0);
      return urgent;
    }

    let selected: TerminalWriteFairOwner | undefined;
    let selectedBalance = Number.NEGATIVE_INFINITY;
    let totalWeight = 0;
    for (const owner of this.pendingOwners) {
      const pending = this.pendingTurns.get(owner);
      if (!pending) continue;
      const weight = TERMINAL_WRITE_PRIORITY_WEIGHT[this.resolvePriority(pending)];
      totalWeight += weight;
      const balance = (this.balances.get(owner) ?? 0) + weight;
      this.balances.set(owner, balance);
      if (balance > selectedBalance) {
        selected = owner;
        selectedBalance = balance;
      }
    }
    if (selected !== undefined) {
      this.balances.set(selected, selectedBalance - totalWeight);
    }
    return selected;
  }

  private resolvePriority(pending: PendingTurn): TerminalWritePriority {
    try {
      const priority = pending.resolvePriority();
      if (priority === "focused" || priority === "foreground" || priority === "background") {
        return priority;
      }
    } catch {
      // Visibility diagnostics must not strand parser admission.
    }
    return "background";
  }

  private release(turn: ActiveTurn): void {
    if (turn.released) return;
    turn.released = true;
    if (this.activeTurn === turn) this.activeTurn = undefined;
    // A pane that requeued before releasing is continuously backlogged and
    // keeps its smooth-WRR balance. A drained pane starts a later burst fresh.
    if (!this.pendingTurns.has(turn.owner)) this.balances.delete(turn.owner);
    this.scheduleNext();
    if (this.activeTurn === undefined && this.pendingTurns.size === 0) this.balances.clear();
  }
}

export const terminalWriteFairScheduler = new TerminalWriteFairScheduler();
