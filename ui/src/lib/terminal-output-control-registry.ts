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

interface BudgetLease {
  release(): void;
}

class OperationBudget {
  private outstandingCount = 0;

  constructor(private readonly maxOutstanding: number) {}

  get outstanding(): number {
    return this.outstandingCount;
  }

  get canStart(): boolean {
    return this.outstandingCount < this.maxOutstanding;
  }

  tryStart(): BudgetLease | undefined {
    if (!this.canStart) return undefined;
    this.outstandingCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.outstandingCount -= 1;
      },
    };
  }
}

interface TerminalEntry {
  attach: OperationBudget;
  ack: OperationBudget;
}

interface CapacityWaiter {
  owner: symbol;
  terminalId: string;
  isCurrent: () => boolean;
  callback: () => void;
}

/**
 * WebView-scoped accounting for uncancellable terminal-output control IPCs.
 *
 * Every operation owns one terminal-local and one WebView-global lease. React
 * mounts own only FIFO recovery callbacks, so unmount cannot forget a pending
 * Promise. The global attach and ACK caps are separate: one wedged control kind
 * cannot consume the other kind's six process-retained slots.
 */
export class TerminalOutputControlOperationRegistry {
  private generation = 0;
  private readonly entries = new Map<string, TerminalEntry>();
  private readonly currentOwners = new Map<string, symbol>();
  private globalBudgets: Record<TerminalOutputControlOperationKind, OperationBudget>;
  private readonly capacityWaiters: Record<TerminalOutputControlOperationKind, CapacityWaiter[]> = {
    attach: [],
    ack: [],
  };
  private readonly capacityReservations: Record<
    TerminalOutputControlOperationKind,
    Map<symbol, BudgetLease>
  > = {
    attach: new Map(),
    ack: new Map(),
  };

  constructor(
    private readonly maxOutstandingPerTerminalKind = 6,
    private readonly maxOutstandingPerWindowKind = 6,
  ) {
    for (const [name, value] of [
      ["terminal", maxOutstandingPerTerminalKind],
      ["window", maxOutstandingPerWindowKind],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`terminal output ${name} operation cap must be a positive integer`);
      }
    }
    this.globalBudgets = {
      attach: new OperationBudget(maxOutstandingPerWindowKind),
      ack: new OperationBudget(maxOutstandingPerWindowKind),
    };
  }

  mount(terminalId: string): TerminalOutputControlMountScope {
    const owner = Symbol(terminalId);
    const previousOwner = this.currentOwners.get(terminalId);
    if (previousOwner) {
      this.removeOwnerWaiters(previousOwner);
      this.releaseOwnerReservations(previousOwner);
    }
    this.currentOwners.set(terminalId, owner);
    let disposed = false;

    const isCurrent = () => !disposed && this.currentOwners.get(terminalId) === owner;
    return {
      canStart: (kind) => isCurrent() && this.canStart(owner, terminalId, kind),
      tryStart: (kind) => {
        if (!isCurrent()) return undefined;
        return this.tryStart(owner, terminalId, kind);
      },
      outstanding: (kind) => this.entries.get(terminalId)?.[kind].outstanding ?? 0,
      waitForCapacity: (kind, callback) => {
        if (!isCurrent()) return;
        this.removeOwnerWaiters(owner, kind);
        this.capacityWaiters[kind].push({ owner, terminalId, isCurrent, callback });
        this.wakeOneCapacityWaiter(kind);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.removeOwnerWaiters(owner);
        this.releaseOwnerReservations(owner);
        if (this.currentOwners.get(terminalId) === owner) this.currentOwners.delete(terminalId);
      },
    };
  }

  /** Test/diagnostic visibility without exposing mutable registry entries. */
  entryCount(): number {
    return this.entries.size;
  }

  /** Test/diagnostic visibility for the hard WebView-wide resource bound. */
  globalOutstanding(kind: TerminalOutputControlOperationKind): number {
    return this.globalBudgets[kind].outstanding;
  }

  /** Test-only isolation for module-global React component fixtures. */
  resetForTests(): void {
    this.generation += 1;
    this.entries.clear();
    this.currentOwners.clear();
    this.capacityWaiters.attach.length = 0;
    this.capacityWaiters.ack.length = 0;
    this.capacityReservations.attach.clear();
    this.capacityReservations.ack.clear();
    this.globalBudgets = {
      attach: new OperationBudget(this.maxOutstandingPerWindowKind),
      ack: new OperationBudget(this.maxOutstandingPerWindowKind),
    };
  }

  private canStart(
    owner: symbol,
    terminalId: string,
    kind: TerminalOutputControlOperationKind,
  ): boolean {
    const local = this.entries.get(terminalId)?.[kind];
    const hasReservation = this.capacityReservations[kind].has(owner);
    return (hasReservation || this.globalBudgets[kind].canStart) && (local?.canStart ?? true);
  }

  private tryStart(
    owner: symbol,
    terminalId: string,
    kind: TerminalOutputControlOperationKind,
  ): TerminalOutputControlOperation | undefined {
    let entry = this.entries.get(terminalId);
    const created = !entry;
    entry ??= this.createEntry();

    // Acquire locally first, then roll it back if the matching global lease is
    // unavailable. Nothing can observe the temporary entry in this synchronous
    // transaction, and no bridge IPC is called until the composite is returned.
    const localLease = entry[kind].tryStart();
    if (!localLease) {
      this.releaseReservation(owner, kind);
      return undefined;
    }
    const globalLease = this.takeReservation(owner, kind) ?? this.globalBudgets[kind].tryStart();
    if (!globalLease) {
      localLease.release();
      if (!created) this.prune(terminalId, entry);
      return undefined;
    }
    if (created) this.entries.set(terminalId, entry);

    const generation = this.generation;
    let settled = false;
    return {
      settle: () => {
        if (settled) return;
        settled = true;
        // Release both halves before pruning or invoking UI callbacks. A waiter
        // therefore observes either the whole composite lease or none of it.
        localLease.release();
        globalLease.release();
        if (this.generation !== generation) return;
        this.prune(terminalId, entry!);
        this.wakeOneCapacityWaiter(kind);
      },
    };
  }

  private createEntry(): TerminalEntry {
    return {
      attach: new OperationBudget(this.maxOutstandingPerTerminalKind),
      ack: new OperationBudget(this.maxOutstandingPerTerminalKind),
    };
  }

  private prune(terminalId: string, entry: TerminalEntry): void {
    if (
      entry.attach.outstanding === 0 &&
      entry.ack.outstanding === 0 &&
      this.entries.get(terminalId) === entry
    ) {
      this.entries.delete(terminalId);
    }
  }

  private removeOwnerWaiters(owner: symbol, kind?: TerminalOutputControlOperationKind): void {
    const kinds: readonly TerminalOutputControlOperationKind[] = kind ? [kind] : ["attach", "ack"];
    for (const candidate of kinds) {
      this.capacityWaiters[candidate] = this.capacityWaiters[candidate].filter(
        (waiter) => waiter.owner !== owner,
      );
    }
  }

  private takeReservation(
    owner: symbol,
    kind: TerminalOutputControlOperationKind,
  ): BudgetLease | undefined {
    const reservation = this.capacityReservations[kind].get(owner);
    if (reservation) this.capacityReservations[kind].delete(owner);
    return reservation;
  }

  private releaseReservation(owner: symbol, kind: TerminalOutputControlOperationKind): void {
    const reservation = this.takeReservation(owner, kind);
    if (!reservation) return;
    reservation.release();
    this.wakeOneCapacityWaiter(kind);
  }

  private releaseOwnerReservations(owner: symbol): void {
    this.releaseReservation(owner, "attach");
    this.releaseReservation(owner, "ack");
  }

  private wakeOneCapacityWaiter(kind: TerminalOutputControlOperationKind): void {
    if (!this.globalBudgets[kind].canStart) return;
    const waiters = this.capacityWaiters[kind];
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      if (!waiter.isCurrent()) {
        waiters.splice(index, 1);
        continue;
      }
      if (this.capacityReservations[kind].has(waiter.owner)) {
        waiters.splice(index, 1);
        continue;
      }
      const local = this.entries.get(waiter.terminalId)?.[kind];
      if (local && !local.canStart) {
        // Keep this terminal's FIFO position, but let an eligible terminal use
        // the global slot so one local cap cannot starve the entire window.
        index += 1;
        continue;
      }
      const reservation = this.globalBudgets[kind].tryStart();
      if (!reservation) return;
      waiters.splice(index, 1);
      this.capacityReservations[kind].set(waiter.owner, reservation);
      try {
        waiter.callback();
      } catch {
        // A UI recovery callback cannot corrupt global resource accounting.
        this.releaseReservation(waiter.owner, kind);
      }
      return;
    }
  }
}

/** One registry per WebView/window; at most 6 attach + 6 ACK IPCs remain pending. */
export const terminalOutputControlOperationRegistry = new TerminalOutputControlOperationRegistry();
