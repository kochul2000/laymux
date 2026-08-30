import { useEffect, useRef } from "react";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { flushSessionCheckpoint } from "@/lib/persist-session";
import { toTerminalId } from "@/lib/pane-ids";
import {
  advanceHiddenTimers,
  computeHiddenPaneIds,
  type HideCandidatePane,
} from "@/lib/hidden-auto-close";

/** How often (ms) the hidden-timer is re-evaluated. */
const TICK_INTERVAL_MS = 5000;

/**
 * Auto-closes terminals that stay hidden past `workspaceSelector.hiddenAutoCloseSeconds`
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
  const pendingEvictionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pendingEvictions = pendingEvictionsRef.current;
    let cancelled = false;
    const evaluate = () => {
      const timeoutSec = useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds;
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

      // Un-hidden panes return immediately. Newly expired panes cross a durable
      // checkpoint barrier before WorkspaceArea unmounts their PTYs.
      const retained = new Set([...ui.evictedPaneIds].filter((paneId) => evictPaneIds.has(paneId)));
      if (
        retained.size !== ui.evictedPaneIds.size ||
        [...retained].some((paneId) => !ui.evictedPaneIds.has(paneId))
      ) {
        ui.setEvictedPaneIds(retained);
      }
      const candidates = [...evictPaneIds].filter(
        (paneId) => !ui.evictedPaneIds.has(paneId) && !pendingEvictions.has(paneId),
      );
      if (candidates.length === 0) return;
      candidates.forEach((paneId) => pendingEvictions.add(paneId));
      void flushSessionCheckpoint({
        reason: "eviction",
        requireConclusive: true,
        terminalIds: candidates.map(toTerminalId),
      })
        .then(() => {
          if (cancelled) return;
          const latestTimeoutSec =
            useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds;
          if (!latestTimeoutSec || latestTimeoutSec <= 0) return;
          const latestUi = useUiStore.getState();
          const latestWs = useWorkspaceStore.getState();
          const latestPanes: HideCandidatePane[] = latestWs.workspaces.flatMap((workspace) =>
            workspace.panes.map((pane) => ({ paneId: pane.id, workspaceId: workspace.id })),
          );
          const stillHidden = computeHiddenPaneIds({
            panes: latestPanes,
            hiddenPaneIds: latestUi.hiddenPaneIds,
            hiddenWorkspaceIds: latestUi.hiddenWorkspaceIds,
            activeWorkspaceId: latestWs.activeWorkspaceId,
          });
          const next = new Set(latestUi.evictedPaneIds);
          const now = Date.now();
          candidates
            .filter((paneId) => {
              const hiddenSince = hiddenSinceRef.current.get(paneId);
              return (
                stillHidden.has(paneId) &&
                hiddenSince !== undefined &&
                now - hiddenSince >= latestTimeoutSec * 1000
              );
            })
            .forEach((paneId) => next.add(paneId));
          latestUi.setEvictedPaneIds(next);
        })
        .catch((error) => {
          console.warn("[hidden-auto-close] Session checkpoint failed; eviction deferred:", error);
        })
        .finally(() => {
          candidates.forEach((paneId) => pendingEvictions.delete(paneId));
        });
    };

    // Raw-state transitions are evaluated synchronously. The interval is only
    // responsible for noticing that an existing timeout has elapsed.
    evaluate();
    const unsubscribeUi = useUiStore.subscribe((state, previous) => {
      if (
        state.hiddenPaneIds !== previous.hiddenPaneIds ||
        state.hiddenWorkspaceIds !== previous.hiddenWorkspaceIds
      ) {
        evaluate();
      }
    });
    const unsubscribeWorkspaces = useWorkspaceStore.subscribe((state, previous) => {
      if (
        state.activeWorkspaceId !== previous.activeWorkspaceId ||
        state.workspaces !== previous.workspaces
      ) {
        evaluate();
      }
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
      if (
        state.workspaceSelector.hiddenAutoCloseSeconds !==
        previous.workspaceSelector.hiddenAutoCloseSeconds
      ) {
        evaluate();
      }
    });
    const timer = setInterval(evaluate, TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      pendingEvictions.clear();
      unsubscribeUi();
      unsubscribeWorkspaces();
      unsubscribeSettings();
    };
  }, []);
}
