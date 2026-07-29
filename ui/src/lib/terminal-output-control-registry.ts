export type TerminalOutputControlOperationKind = "attach" | "ack";

export interface TerminalOutputControlOperation {
  /** Release one uncancellable bridge operation exactly once. */
  settle(): void;
}

export interface TerminalOutputControlMountScope {
  canStart(kind: TerminalOutputControlOperationKind): boolean;
  tryStart(kind: TerminalOutputControlOperationKind): TerminalOutputControlOperation | undefined;
  outstanding(kind: TerminalOutputControlOperationKind): number;
  waitForCapacity(kind: TerminalOutputControlOperationKind, waiter: () => void): void;
  dispose(): void;
}

interface CapacityWaiter {
  owner: symbol;
  isCurrent: () => boolean;
  callback: () => void;
}

class OperationBudget {
  private outstandingCount = 0;
  private capacityWaiter: CapacityWaiter | undefined;

  constructor(private readonly maxOutstanding: number) {}

  get outstanding(): number {
    return this.outstandingCount;
  }

  get canStart(): boolean {
    return this.outstandingCount < this.maxOutstanding;
  }

  tryStart(onSettled: () => void): TerminalOutputControlOperation | undefined {
    if (!this.canStart) return undefined;
    this.outstandingCount += 1;
    let settled = false;
    return {
      settle: () => {
        if (settled) return;
        settled = true;
        this.outstandingCount -= 1;
        this.wakeCapacityWaiter();
        onSettled();
      },
    };
  }

  waitForCapacity(waiter: CapacityWaiter): void {
    this.capacityWaiter = waiter;
    this.wakeCapacityWaiter();
  }

  clearCapacityWaiter(owner?: symbol): void {
    if (owner !== undefined && this.capacityWaiter?.owner !== owner) return;
    this.capacityWaiter = undefined;
  }

  private wakeCapacityWaiter(): void {
    if (!this.canStart || !this.capacityWaiter) return;
    const waiter = this.capacityWaiter;
    this.capacityWaiter = undefined;
    if (!waiter.isCurrent()) return;
    try {
      waiter.callback();
    } catch {
      // A UI recovery callback cannot corrupt process-lifetime accounting.
    }
  }
}

interface TerminalEntry {
  currentOwner?: symbol;
  owners: Set<symbol>;
  attach: OperationBudget;
  ack: OperationBudget;
}

/**
 * Window-scoped accounting for uncancellable terminal-output control IPCs.
 *
 * React mounts only own recovery callbacks. An operation lease remains in its
 * terminal-id entry until the underlying Promise settles, even after the mount
 * and backend session that started it have gone away. This makes rapid remounts
 * share one real resource cap instead of resetting it with each effect.
 */
export class TerminalOutputControlOperationRegistry {
  private readonly entries = new Map<string, TerminalEntry>();

  constructor(private readonly maxOutstandingPerKind = 6) {
    if (!Number.isInteger(maxOutstandingPerKind) || maxOutstandingPerKind <= 0) {
      throw new Error("terminal output operation cap must be a positive integer");
    }
  }

  mount(terminalId: string): TerminalOutputControlMountScope {
    let entry = this.entries.get(terminalId);
    if (!entry) {
      entry = {
        owners: new Set(),
        attach: new OperationBudget(this.maxOutstandingPerKind),
        ack: new OperationBudget(this.maxOutstandingPerKind),
      };
      this.entries.set(terminalId, entry);
    }

    const owner = Symbol(terminalId);
    entry.owners.add(owner);
    entry.currentOwner = owner;
    // A remount supersedes every UI callback from the previous surface. The
    // operation leases themselves deliberately remain in the shared budgets.
    entry.attach.clearCapacityWaiter();
    entry.ack.clearCapacityWaiter();
    let disposed = false;

    const isCurrent = () => !disposed && entry?.currentOwner === owner;
    const budgetFor = (kind: TerminalOutputControlOperationKind) => entry![kind];

    return {
      canStart: (kind) => isCurrent() && budgetFor(kind).canStart,
      tryStart: (kind) => {
        if (!isCurrent()) return undefined;
        return budgetFor(kind).tryStart(() => this.prune(terminalId, entry!));
      },
      outstanding: (kind) => budgetFor(kind).outstanding,
      waitForCapacity: (kind, callback) => {
        if (!isCurrent()) return;
        budgetFor(kind).waitForCapacity({ owner, isCurrent, callback });
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        entry!.attach.clearCapacityWaiter(owner);
        entry!.ack.clearCapacityWaiter(owner);
        entry!.owners.delete(owner);
        if (entry!.currentOwner === owner) entry!.currentOwner = undefined;
        this.prune(terminalId, entry!);
      },
    };
  }

  /** Test/diagnostic visibility without exposing mutable registry entries. */
  entryCount(): number {
    return this.entries.size;
  }

  private prune(terminalId: string, entry: TerminalEntry): void {
    if (
      entry.owners.size === 0 &&
      entry.attach.outstanding === 0 &&
      entry.ack.outstanding === 0 &&
      this.entries.get(terminalId) === entry
    ) {
      this.entries.delete(terminalId);
    }
  }
}

/** One registry per WebView/window; entries survive React effect remounts. */
export const terminalOutputControlOperationRegistry = new TerminalOutputControlOperationRegistry();
