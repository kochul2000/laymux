import { useEffect, useRef } from "react";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { checkpointAndCloseHiddenTerminals } from "@/lib/tauri-api";
import { toPaneId, toTerminalId } from "@/lib/pane-ids";
import {
  advanceHiddenTimers,
  computeHiddenPaneIds,
  type HideCandidatePane,
} from "@/lib/hidden-auto-close";
import { claimHiddenEvictionEligibility } from "@/lib/hidden-eviction-eligibility";

/** How often (ms) the hidden-timer is re-evaluated. */
const TICK_INTERVAL_MS = 5000;

/**
 * Auto-closes terminals that stay hidden past `workspaceSelector.hiddenAutoCloseSeconds`
 * (issue #269). The hook tracks how long each hidden pane has been hidden and,
 * once the timeout elapses, records the pane in `uiStore.evictedPaneIds`.
 * A backend transaction first drains mutations, commits a critical checkpoint,
 * and closes the PTY. `WorkspaceArea` then stops rendering only the pane IDs the
 * backend confirmed closed. Un-hiding a pane drops it from the eviction set,
 * re-mounting it with a fresh PTY.
 *
 * No-op (and eagerly clears any pending evictions) when the timeout is 0/disabled.
 */
export function useHiddenTerminalAutoClose() {
  // Per-pane timestamp (ms) of when the pane first became hidden. Lives in a ref
  // so it survives re-renders without itself triggering renders.
  const hiddenSinceRef = useRef<Map<string, number>>(new Map());
  const pendingEvictionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const eligibility = claimHiddenEvictionEligibility();
    const pendingEvictions = pendingEvictionsRef.current;
    let cancelled = false;
    const evaluate = () => {
      if (cancelled) return;
      const timeoutSec = useSettingsStore.getState().workspaceSelector.hiddenAutoCloseSeconds;
      const ui = useUiStore.getState();

      // Disabled: clear timers + any prior evictions so terminals re-mount.
      if (!timeoutSec || timeoutSec <= 0) {
        hiddenSinceRef.current = new Map();
        eligibility.publish(new Set());
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
      eligibility.publish(evictPaneIds);

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
      void checkpointAndCloseHiddenTerminals(candidates.map(toTerminalId))
        .then(({ closedTerminalIds, failedTerminalIds }) => {
          if (failedTerminalIds.length > 0) {
            console.warn(
              "[hidden-auto-close] Backend kept terminals whose eviction could not complete:",
              failedTerminalIds,
            );
          }
          const latestUi = useUiStore.getState();
          const closedPaneIds = new Set(closedTerminalIds.map(toPaneId));
          if (closedPaneIds.size === 0) return;

          // Backend close already happened. Reflect every closed PTY as evicted
          // first, even if visibility/timeout changed while the critical
          // checkpoint was pending; otherwise a still-mounted TerminalView
          // would point at a dead backend session. The current effect subscribes
          // to this eviction-set transition and immediately remounts panes that
          // are no longer eligible, even if an older StrictMode effect owns this
          // late response.
          const next = new Set(latestUi.evictedPaneIds);
          closedPaneIds.forEach((paneId) => next.add(paneId));
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
        state.hiddenWorkspaceIds !== previous.hiddenWorkspaceIds ||
        state.evictedPaneIds !== previous.evictedPaneIds
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
      eligibility.release();
    };
  }, []);
}
