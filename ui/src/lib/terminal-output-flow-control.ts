import type { TerminalOutputControlOperation } from "./terminal-output-control-registry";

export interface TerminalOutputFlowAcknowledgerOptions {
  retryMs?: number;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
  onLeaseLost?: () => void;
  onTimeout?: () => void;
  onConfirmed?: (seq: number) => void;
  tryStartOperation?: () => TerminalOutputControlOperation | undefined;
  onAdmissionBlocked?: () => void;
}

const DEFAULT_ACK_RETRY_MS = 50;
const DEFAULT_ACK_TIMEOUT_MS = 5_000;

/**
 * Coalesces parsed terminal-output ranges into one monotonic backend ACK.
 *
 * A completion beyond a hole is remembered but cannot advance the contiguous
 * prefix. Only one IPC is in flight; progress made behind it is folded into the
 * next ACK. The instance belongs to one attach token and must be disposed when
 * that token is superseded.
 */
export class TerminalOutputFlowAcknowledger {
  private contiguousSeq: number;
  private confirmedSeq: number;
  private readonly completed = new Map<number, number>();
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly onLeaseLost?: () => void;
  private readonly onTimeout?: () => void;
  private readonly onConfirmed?: (seq: number) => void;
  private readonly tryStartOperation?: () => TerminalOutputControlOperation | undefined;
  private readonly onAdmissionBlocked?: () => void;
  private inFlight = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    initialSeq: number,
    private readonly send: (seq: number) => Promise<boolean>,
    options: TerminalOutputFlowAcknowledgerOptions = {},
  ) {
    this.contiguousSeq = initialSeq;
    this.confirmedSeq = initialSeq;
    this.retryMs = options.retryMs ?? DEFAULT_ACK_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.onError = options.onError;
    this.onLeaseLost = options.onLeaseLost;
    this.onTimeout = options.onTimeout;
    this.onConfirmed = options.onConfirmed;
    this.tryStartOperation = options.tryStartOperation;
    this.onAdmissionBlocked = options.onAdmissionBlocked;
  }

  complete(seqStart: number, seqEnd: number): void {
    if (this.disposed || seqEnd <= this.contiguousSeq) return;
    const start = Math.max(seqStart, this.contiguousSeq);
    const previousEnd = this.completed.get(start) ?? start;
    if (seqEnd > previousEnd) this.completed.set(start, seqEnd);
    this.advanceContiguousPrefix();
    this.pump();
  }

  /**
   * Release a range only after both terminal models parsed it. The visible
   * xterm and the rendererless checkpoint are independent consumers; producer
   * credit is their contiguous-prefix intersection, never the faster one.
   */
  completeAfterBothParsed(
    seqStart: number,
    seqEnd: number,
    visibleParsed: PromiseLike<void>,
    checkpointParsed: PromiseLike<void>,
  ): void {
    void Promise.all([visibleParsed, checkpointParsed])
      .then(() => this.complete(seqStart, seqEnd))
      // The caller owns parse failure policy (normally one epoch-guarded
      // reattach). `onError` is reserved for ACK IPC failures that this class
      // actually retries.
      .catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.completed.clear();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.clearWatchdog();
  }

  private advanceContiguousPrefix(): void {
    for (;;) {
      let advanced = false;
      for (const [start, end] of this.completed) {
        if (end <= this.contiguousSeq) {
          this.completed.delete(start);
          continue;
        }
        if (start > this.contiguousSeq) continue;
        this.completed.delete(start);
        this.contiguousSeq = end;
        advanced = true;
        break;
      }
      if (!advanced) return;
    }
  }

  private pump(): void {
    if (
      this.disposed ||
      this.inFlight ||
      this.retryTimer !== undefined ||
      this.contiguousSeq <= this.confirmedSeq
    ) {
      return;
    }
    const sentSeq = this.contiguousSeq;
    let operation: TerminalOutputControlOperation | undefined;
    if (this.tryStartOperation) {
      try {
        operation = this.tryStartOperation();
      } catch {
        operation = undefined;
      }
      if (!operation) {
        this.dispose();
        try {
          this.onAdmissionBlocked?.();
        } catch {
          // Capacity recovery belongs to the current epoch owner.
        }
        return;
      }
    }
    const settleOperation = () => {
      const active = operation;
      operation = undefined;
      try {
        active?.settle();
      } catch {
        // Resource bookkeeping cannot change ACK completion semantics.
      }
    };
    this.inFlight = true;
    let sending: Promise<boolean>;
    try {
      sending = this.send(sentSeq);
    } catch (error) {
      // Treat a synchronous bridge/test-double throw exactly like a rejected
      // IPC promise so the credit prefix is retried, never lost.
      sending = Promise.reject(error);
    }
    this.watchdogTimer = setTimeout(
      () => {
        this.watchdogTimer = undefined;
        if (this.disposed) return;
        // The bridge Promise itself cannot be cancelled. Retire this token owner
        // first, then ask the current UI epoch to replace it. Its already-wired
        // handlers below absorb a late resolve/reject without touching prefix
        // state or scheduling the ordinary rejection retry.
        this.dispose();
        try {
          this.onTimeout?.();
        } catch {
          // Recovery diagnostics/callbacks cannot revive a stale sender.
        }
      },
      Math.max(0, this.timeoutMs),
    );
    void sending
      .then((accepted) => {
        this.clearWatchdog();
        settleOperation();
        if (this.disposed) return;
        if (!accepted) {
          // A replacement attach owns the backend lease. Never retry a stale
          // token or let its late completion advance the new generation. The
          // active owner must also replace its UI epoch: silently stopping ACKs
          // would leave the backend producer blocked on an ownerless lease.
          this.dispose();
          try {
            this.onLeaseLost?.();
          } catch {
            // Recovery diagnostics/callbacks cannot revive a stale sender.
          }
          return;
        }
        this.confirmedSeq = Math.max(this.confirmedSeq, sentSeq);
        try {
          this.onConfirmed?.(this.confirmedSeq);
        } catch {
          // Diagnostics/backoff bookkeeping cannot stop parsed credit.
        }
      })
      .catch((error) => {
        this.clearWatchdog();
        settleOperation();
        if (this.disposed) return;
        try {
          this.onError?.(error);
        } catch {
          // Diagnostics cannot stop the credit retry loop.
        }
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.pump();
        }, this.retryMs);
      })
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer === undefined) return;
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }
}
