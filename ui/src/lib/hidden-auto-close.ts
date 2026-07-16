/**
 * Pure helpers for the "auto-close hidden terminals" feature (issue #269).
 *
 * When a pane or workspace stays hidden (via the WorkspaceSelectorView list actions)
 * for longer than the configured timeout, its terminal (PTY) is torn down to free
 * memory/CPU. Eviction is implemented by unmounting the pane's `TerminalView`
 * (WorkspaceArea stops rendering it); the existing `TerminalView` unmount cleanup
 * closes the PTY session. When the pane is un-hidden it re-mounts and a fresh PTY
 * is spawned.
 *
 * This module holds only the pure decision logic so it can be unit-tested without
 * timers, React, or Tauri. The wiring lives in `useHiddenTerminalAutoClose`.
 */

/** A pane that is a candidate for hide-based eviction. */
export interface HideCandidatePane {
  /** Stable pane id (matches `WorkspacePane.id`). */
  paneId: string;
  /** Workspace the pane belongs to. */
  workspaceId: string;
}

export interface ComputeHiddenInput {
  /** All panes across all workspaces. */
  panes: HideCandidatePane[];
  /** Pane ids hidden individually. */
  hiddenPaneIds: Set<string>;
  /** Workspace ids hidden as a whole. */
  hiddenWorkspaceIds: Set<string>;
  /**
   * Currently active workspace id. Panes in the active workspace are never
   * considered hidden — the user is looking at them.
   */
  activeWorkspaceId: string | null;
}

/**
 * Returns the set of pane ids that are currently hidden and therefore eligible
 * for the auto-close countdown. A pane is hidden when it (or its workspace) is
 * flagged hidden AND it does not belong to the active workspace.
 */
export function computeHiddenPaneIds(input: ComputeHiddenInput): Set<string> {
  const { panes, hiddenPaneIds, hiddenWorkspaceIds, activeWorkspaceId } = input;
  const result = new Set<string>();
  for (const pane of panes) {
    if (pane.workspaceId === activeWorkspaceId) continue;
    const hidden = hiddenPaneIds.has(pane.paneId) || hiddenWorkspaceIds.has(pane.workspaceId);
    if (hidden) result.add(pane.paneId);
  }
  return result;
}

export interface AdvanceTimersInput {
  /** Pane ids currently hidden (output of `computeHiddenPaneIds`). */
  hiddenPaneIds: Set<string>;
  /** Existing paneId → timestamp(ms) the pane first became hidden. */
  hiddenSince: Map<string, number>;
  /** Current time in ms (epoch). */
  now: number;
  /** Timeout in ms before a hidden pane is evicted. <= 0 disables eviction. */
  timeoutMs: number;
}

export interface AdvanceTimersResult {
  /** Updated hiddenSince map (panes no longer hidden are dropped). */
  hiddenSince: Map<string, number>;
  /** Pane ids that have been hidden long enough to evict (close the PTY). */
  evictPaneIds: Set<string>;
}

/**
 * Advance the per-pane hidden timers and decide which panes to evict.
 *
 * - A pane newly appearing in `hiddenPaneIds` gets its `hiddenSince` stamped to `now`.
 * - A pane that left `hiddenPaneIds` (was un-hidden) is dropped from `hiddenSince`.
 * - When `timeoutMs > 0` and `now - hiddenSince >= timeoutMs`, the pane is evicted.
 *
 * The function is pure: it returns a fresh map and never mutates its inputs.
 */
export function advanceHiddenTimers(input: AdvanceTimersInput): AdvanceTimersResult {
  const { hiddenPaneIds, hiddenSince, now, timeoutMs } = input;
  const nextHiddenSince = new Map<string, number>();
  const evictPaneIds = new Set<string>();

  for (const paneId of hiddenPaneIds) {
    const since = hiddenSince.get(paneId) ?? now;
    nextHiddenSince.set(paneId, since);
    if (timeoutMs > 0 && now - since >= timeoutMs) {
      evictPaneIds.add(paneId);
    }
  }

  return { hiddenSince: nextHiddenSince, evictPaneIds };
}
