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

export type TerminalWriteClassShare = Record<TerminalWritePriority, number>;

/**
 * Share of parser admission turns each priority class receives (ADR-0101).
 *
 * The share belongs to the class, not to a pane. A per-pane weight divides the
 * active workspace's share by however many hidden panes exist, so a large hidden
 * crowd erases it (issue #686); a class share does not. The sum is the cycle
 * length in turns when all three classes have pending panes, so `5/3/2` means
 * 50% focused, 30% for the rest of the active workspace, 20% for every hidden
 * pane together. Panes inside one class then take turns round-robin.
 */
export const TERMINAL_WRITE_DEFAULT_CLASS_SHARE: TerminalWriteClassShare = {
  focused: 5,
  foreground: 3,
  background: 2,
};

/** Hidden panes must keep making progress, so no class may be starved to zero. */
export const TERMINAL_WRITE_MIN_CLASS_SHARE = 1;

/** Bounds the cycle length a settings file can ask the scheduler to honour. */
export const TERMINAL_WRITE_MAX_CLASS_SHARE = 1000;

const TERMINAL_WRITE_PRIORITY_CLASSES: readonly TerminalWritePriority[] = [
  "focused",
  "foreground",
  "background",
];

/** Reduce a settings-provided share table to integers the scheduler can use. */
export function sanitizeTerminalWriteClassShare(share: unknown): TerminalWriteClassShare {
  const source = (share ?? {}) as Partial<Record<TerminalWritePriority, unknown>>;
  const sanitized = { ...TERMINAL_WRITE_DEFAULT_CLASS_SHARE };
  for (const priority of TERMINAL_WRITE_PRIORITY_CLASSES) {
    const value = Number(source[priority]);
    if (!Number.isFinite(value)) continue;
    sanitized[priority] = Math.min(
      TERMINAL_WRITE_MAX_CLASS_SHARE,
      Math.max(TERMINAL_WRITE_MIN_CLASS_SHARE, Math.floor(value)),
    );
  }
  return sanitized;
}

/** Let non-MessageChannel browser task sources compete at least once per pane round. */
export const TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS = 8;

/** Create an identity token scoped to one TerminalView xterm effect lifetime. */
export function createTerminalWriteFairOwner(debugLabel?: string): TerminalWriteFairOwner {
  return Symbol(debugLabel);
}

type ScheduleMacrotask = (task: () => void) => void;

function createTerminalWriteMacrotaskScheduler(): ScheduleMacrotask {
  const tasks: Array<() => void> = [];
  let channel: MessageChannel | undefined;
  let channelUnavailable = false;
  let messageHandoffsSinceControlYield = 0;
  const postMessageTask = (task: () => void): boolean => {
    const MessageChannelConstructor =
      typeof window === "undefined" ? undefined : window.MessageChannel;
    if (!channelUnavailable && typeof MessageChannelConstructor === "function") {
      try {
        if (!channel) {
          channel = new MessageChannelConstructor();
          channel.port1.onmessage = () => tasks.shift()?.();
        }
        tasks.push(task);
        channel.port2.postMessage(undefined);
        return true;
      } catch {
        tasks.length = 0;
        channel?.port1.close();
        channel?.port2.close();
        channel = undefined;
        channelUnavailable = true;
      }
    }
    return false;
  };
  return (task) => {
    if (messageHandoffsSinceControlYield >= TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS - 1) {
      messageHandoffsSinceControlYield = 0;
      // The timer is only a gate. Run the parser turn from a subsequent
      // MessageChannel task so xterm's own timer chain starts non-nested.
      setTimeout(() => {
        if (!postMessageTask(task)) task();
      }, 0);
      return;
    }
    if (postMessageTask(task)) {
      messageHandoffsSinceControlYield += 1;
      return;
    }
    messageHandoffsSinceControlYield = 0;
    setTimeout(task, 0);
  };
}

type ActiveTurn = {
  owner: TerminalWriteFairOwner;
  released: boolean;
};

type PendingTurn = {
  turn: TerminalWriteFairTurn;
  resolvePriority: TerminalWritePriorityResolver;
};

/**
 * App-wide two-tier admission for physical xterm writes.
 *
 * A TerminalView keeps ownership of its byte FIFO and parse completion. This
 * scheduler owns only the scarce main-thread admission turn: one pane submits
 * one bounded parser quantum, holds the turn through its parse callback(s),
 * then returns to the tail if it still has work. The next pane always starts
 * in a fresh macrotask so input, paint, and control work can run between turns.
 *
 * Turns go first to a priority class by its configured share, then to the
 * longest-waiting pane of that class. So the active workspace keeps its share
 * whether three or three hundred hidden panes are flooding.
 */
export class TerminalWriteFairScheduler {
  private readonly pendingTurns = new Map<TerminalWriteFairOwner, PendingTurn>();
  private readonly classBalances = new Map<TerminalWritePriority, number>();
  private classShare: TerminalWriteClassShare = { ...TERMINAL_WRITE_DEFAULT_CLASS_SHARE };
  private pendingOwners: TerminalWriteFairOwner[] = [];
  private activeTurn: ActiveTurn | undefined;
  private macrotaskScheduled = false;
  private macrotaskGeneration = 0;

  constructor(
    private readonly scheduleMacrotask: ScheduleMacrotask = createTerminalWriteMacrotaskScheduler(),
  ) {}

  /** Queue at most one future turn for a mounted terminal pane. */
  request(
    owner: TerminalWriteFairOwner,
    turn: TerminalWriteFairTurn,
    resolvePriority: TerminalWritePriorityResolver = () => "foreground",
  ): void {
    if (this.pendingTurns.has(owner)) return;
    this.pendingTurns.set(owner, { turn, resolvePriority });
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

  /**
   * Adopt the configured class shares (`terminal.parserAdmission` in
   * settings.json). Invalid or missing entries fall back to the defaults.
   */
  setClassShare(share: unknown): void {
    this.classShare = sanitizeTerminalWriteClassShare(share);
    // Balances are denominated in the old shares. Drop them so the next cycle
    // starts from the new ratio instead of paying off a rescaled debt.
    this.classBalances.clear();
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

  /** Test/diagnostic visibility of the shares currently in force. */
  classShareForTests(): TerminalWriteClassShare {
    return { ...this.classShare };
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
    this.classBalances.clear();
    this.classShare = { ...TERMINAL_WRITE_DEFAULT_CLASS_SHARE };
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
    // Tier 1 picks a class by its share; tier 2 picks that class's
    // longest-waiting pane. Only classes that actually have a pending pane join
    // the cycle, so an idle class lends its share to the busy ones.
    const longestWaitingPerClass = new Map<TerminalWritePriority, TerminalWriteFairOwner>();
    for (const owner of this.pendingOwners) {
      const pending = this.pendingTurns.get(owner);
      if (!pending) continue;
      const priority = this.resolvePriority(pending);
      if (!longestWaitingPerClass.has(priority)) longestWaitingPerClass.set(priority, owner);
    }
    if (longestWaitingPerClass.size === 0) return undefined;

    let selectedClass: TerminalWritePriority | undefined;
    let selectedBalance = Number.NEGATIVE_INFINITY;
    let totalShare = 0;
    for (const priority of longestWaitingPerClass.keys()) {
      const share = this.classShare[priority];
      totalShare += share;
      const balance = (this.classBalances.get(priority) ?? 0) + share;
      this.classBalances.set(priority, balance);
      if (balance > selectedBalance) {
        selectedClass = priority;
        selectedBalance = balance;
      }
    }
    if (selectedClass === undefined) return undefined;
    this.classBalances.set(selectedClass, selectedBalance - totalShare);
    return longestWaitingPerClass.get(selectedClass);
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
    this.scheduleNext();
    // Class balances only mean something while classes are competing. Once the
    // app drains, a later burst starts from an even cycle instead of old debt.
    if (this.activeTurn === undefined && this.pendingTurns.size === 0) this.classBalances.clear();
  }
}

export const terminalWriteFairScheduler = new TerminalWriteFairScheduler();
