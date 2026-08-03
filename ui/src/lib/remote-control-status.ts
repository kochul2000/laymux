import { useSyncExternalStore } from "react";
import {
  getRemoteControlStatus,
  onRemoteControlChanged,
  type RemoteControlStatus,
} from "@/lib/tauri-api";

export const REMOTE_CONTROL_STATUS_POLL_MS = 3_000;

type SnapshotListener = () => void;

export interface RemoteControlStatusSnapshot {
  status: RemoteControlStatus | null;
  /** Increments for every observed Remote → Local owner transition. */
  releaseRevision: number;
}

function sameStatus(a: RemoteControlStatus | null, b: RemoteControlStatus | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.active === b.active &&
      a.leaseId === b.leaseId &&
      a.remoteAddr === b.remoteAddr &&
      a.clientName === b.clientName &&
      a.heartbeatTimeoutSeconds === b.heartbeatTimeoutSeconds)
  );
}

/** One desktop-window owner for Remote control events, snapshots, and fallback polling. */
class RemoteControlStatusCoordinator {
  private readonly listeners = new Set<SnapshotListener>();
  private snapshot: RemoteControlStatusSnapshot = { status: null, releaseRevision: 0 };
  private started = false;
  private generation = 0;
  private eventRevision = 0;
  private queryEpoch = 0;
  private inFlightQuery: number | null = null;
  private unlisten: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private listenerRetryTimer: ReturnType<typeof setTimeout> | undefined;

  getSnapshot = (): RemoteControlStatusSnapshot => this.snapshot;

  subscribe = (listener: SnapshotListener): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  publish = (status: RemoteControlStatus): void => {
    this.handleEvent(status, this.generation);
  };

  private handleEvent(status: RemoteControlStatus, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.eventRevision += 1;
    this.apply(status, generation);
  }

  resetForTest(): void {
    this.listeners.clear();
    this.stop();
    this.snapshot = { status: null, releaseRevision: 0 };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    this.installListener(generation);
  }

  private stop(): void {
    if (!this.started && this.snapshot.status === null) return;
    this.started = false;
    this.generation += 1;
    this.queryEpoch += 1;
    this.inFlightQuery = null;
    this.clearPollTimer();
    if (this.listenerRetryTimer !== undefined) clearTimeout(this.listenerRetryTimer);
    this.listenerRetryTimer = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    this.setStatus(null);
  }

  private isCurrent(generation: number): boolean {
    return this.started && generation === this.generation;
  }

  private setStatus(status: RemoteControlStatus | null): void {
    if (sameStatus(this.snapshot.status, status)) return;
    const released = this.snapshot.status?.active === true && status?.active === false;
    this.snapshot = {
      status,
      releaseRevision: this.snapshot.releaseRevision + (released ? 1 : 0),
    };
    for (const listener of this.listeners) listener();
  }

  private apply(status: RemoteControlStatus, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.clearPollTimer();
    this.setStatus(status);
    if (status.active) this.schedulePoll(generation);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll(generation: number): void {
    if (!this.isCurrent(generation) || this.pollTimer !== undefined || this.inFlightQuery !== null)
      return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.refresh(generation);
    }, REMOTE_CONTROL_STATUS_POLL_MS);
  }

  private scheduleListenerRetry(generation: number): void {
    if (!this.isCurrent(generation) || this.listenerRetryTimer !== undefined) return;
    this.listenerRetryTimer = setTimeout(() => {
      this.listenerRetryTimer = undefined;
      this.installListener(generation);
    }, REMOTE_CONTROL_STATUS_POLL_MS);
  }

  private installListener(generation: number): void {
    onRemoteControlChanged((status) => this.handleEvent(status, generation))
      .then((cleanup) => {
        if (!this.isCurrent(generation)) {
          cleanup();
          return;
        }
        this.unlisten = cleanup;
        void this.refresh(generation);
      })
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        this.setStatus(null);
        this.scheduleListenerRetry(generation);
      });
  }

  private async refresh(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.inFlightQuery !== null) return;
    const queryEpoch = ++this.queryEpoch;
    const eventRevision = this.eventRevision;
    this.inFlightQuery = queryEpoch;
    try {
      const status = await getRemoteControlStatus();
      if (
        !this.isCurrent(generation) ||
        this.inFlightQuery !== queryEpoch ||
        this.eventRevision !== eventRevision
      ) {
        return;
      }
      this.apply(status, generation);
    } catch {
      // Keep the last observed status; the sequential fallback is restored below.
    } finally {
      if (this.inFlightQuery === queryEpoch) {
        this.inFlightQuery = null;
        if (this.snapshot.status === null || this.snapshot.status.active)
          this.schedulePoll(generation);
      }
    }
  }
}

const coordinator = new RemoteControlStatusCoordinator();

export function useRemoteControlStatus(): RemoteControlStatus | null {
  return useRemoteControlStatusSnapshot().status;
}

export function useRemoteControlStatusSnapshot(): RemoteControlStatusSnapshot {
  return useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
}

/** Publish a command response immediately instead of waiting for its matching event. */
export function publishRemoteControlStatus(status: RemoteControlStatus): void {
  coordinator.publish(status);
}

export function __resetRemoteControlStatusForTest(): void {
  coordinator.resetForTest();
}
