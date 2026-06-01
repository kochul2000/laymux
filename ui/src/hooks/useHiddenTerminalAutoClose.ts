import { useEffect, useRef } from "react";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  advanceHiddenTimers,
  computeHiddenPaneIds,
  type HideCandidatePane,
} from "@/lib/hidden-auto-close";

/** How often (ms) the hidden-timer is re-evaluated. */
const TICK_INTERVAL_MS = 5000;

/**
 * Auto-closes terminals that stay hidden past `convenience.hiddenAutoCloseSeconds`
 * (issue #269). The hook tracks how long each hidden pane has been hidden and,
 * once the timeout elapses, records the pane in `uiStore.evictedPaneIds`.
 * `WorkspaceArea` then stops rendering that pane, unmounting its `TerminalView`,
 * whose cleanup tears down the PTY. Un-hiding a pane drops it from the eviction
 * set, re-mounting it with a fresh PTY.
 *
 * No-op (and eagerly clears any pending evictions) when the timeout is 0/disabled.
 */
export function useHiddenTerminalAutoClose() {
  // Per-pane timestamp (ms) of when the pane first became hidden. Lives in a ref
  // so it survives re-renders without itself triggering renders.
  const hiddenSinceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const evaluate = () => {
      const timeoutSec = useSettingsStore.getState().convenience.hiddenAutoCloseSeconds;
      const ui = useUiStore.getState();

      // Disabled: clear timers + any prior evictions so terminals re-mount.
      if (!timeoutSec || timeoutSec <= 0) {
        hiddenSinceRef.current = new Map();
        if (ui.evictedPaneIds.size > 0) ui.setEvictedPaneIds(new Set());
        return;
      }

      const ws = useWorkspaceStore.getState();
      const panes: HideCandidatePane[] = ws.workspaces.flatMap((w) =>
        w.panes.map((p) => ({ paneId: p.id, workspaceId: w.id })),
      );

      const hiddenPaneIds = computeHiddenPaneIds({
        panes,
        hiddenPaneIds: ui.hiddenPaneIds,
        hiddenWorkspaceIds: ui.hiddenWorkspaceIds,
        activeWorkspaceId: ws.activeWorkspaceId,
      });

      const { hiddenSince, evictPaneIds } = advanceHiddenTimers({
        hiddenPaneIds,
        hiddenSince: hiddenSinceRef.current,
        now: Date.now(),
        timeoutMs: timeoutSec * 1000,
      });
      hiddenSinceRef.current = hiddenSince;
      ui.setEvictedPaneIds(evictPaneIds);
    };

    // Run immediately so toggling a pane hidden starts the countdown without
    // waiting a full tick, then poll on an interval.
    evaluate();
    const timer = setInterval(evaluate, TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}
