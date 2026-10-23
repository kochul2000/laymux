import { useEffect } from "react";

import {
  acknowledgeSessionCheckpoint,
  onSessionCheckpointRequested,
  onAppUpdateStatusChanged,
  reportAppUpdatePreparation,
} from "@/lib/tauri-api";
import {
  flushSessionCheckpoint,
  markSessionCheckpointMutation,
  persistSession,
  cacheTerminalOutputs,
  setPreparingUpdate,
} from "@/lib/persist-session";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { SESSION_ATTRIBUTION_STARTUP_GRACE_MS } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { areHiddenPaneIdsEligible } from "@/lib/hidden-eviction-eligibility";
import { toPaneId } from "@/lib/pane-ids";
import { flushTerminalDisplayContexts } from "@/lib/terminal-display-context";

function hiddenEvictionTargetsRemainEligible(terminalIds: readonly string[]): boolean {
  return areHiddenPaneIdsEligible(terminalIds.map(toPaneId));
}

/** Connect native watchdog/update barriers and workspace-entry hints to one coordinator. */
export function useSessionCheckpointLifecycle(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let stopUpdate: (() => void) | undefined;
    let nativePreparing = false;
    void onAppUpdateStatusChanged((status) => {
      if (cancelled) return;
      nativePreparing = status.operation === "preparing" || status.operation === "installing";
      setPreparingUpdate(nativePreparing);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopUpdate = stop;
      })
      .catch((error) => {
        console.warn("[session-checkpoint] Update status subscription failed:", error);
      });
    let workspaceEntryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleWorkspaceEntryCatchUp = () => {
      if (workspaceEntryTimer) clearTimeout(workspaceEntryTimer);
      workspaceEntryTimer = setTimeout(() => {
        void persistSession({ reason: "workspaceEntry" });
      }, SESSION_ATTRIBUTION_STARTUP_GRACE_MS);
    };

    void onSessionCheckpointRequested((request) => {
      if (cancelled) {
        // A listener can already be registered while its Promise is still
        // settling. StrictMode may clean up that effect in this window, but a
        // native request delivered to the retired callback still owns a Rust
        // oneshot and must receive an explicit failure instead of timing out.
        void acknowledgeSessionCheckpoint(
          request.requestId,
          undefined,
          "session checkpoint listener cancelled",
        ).catch((error) => {
          console.warn("[session-checkpoint] Failed to reject cancelled native request:", error);
        });
        return;
      }
      const updating = request.reason === "update";
      if (updating) setPreparingUpdate(true);
      // Update checkpoints observe and save; only explicit close may inject
      // Codex /status. Rust scopes critical validation to PTYs that will end
      // with this GUI, while the snapshot still includes every pane (ADR-0323).
      void flushSessionCheckpoint({
        reason: request.reason,
        requireConclusive: request.requireConclusive,
        terminalIds: request.terminalIds,
      })
        .then(async (commit) => {
          if (request.reason === "update") {
            if (cancelled) throw new Error("update preparation listener cancelled");
            setPreparingUpdate(true);
            // Never the explicit-exit Ctrl+C: the PTY daemon keeps every
            // session across the restart (ADR-0308, ADR-0314).
            await cacheTerminalOutputs(async (progress) => {
              if (cancelled) throw new Error("update preparation listener cancelled");
              await reportAppUpdatePreparation(request.requestId, progress);
            });
            await flushTerminalDisplayContexts();
          }
          if (
            request.reason === "eviction" &&
            !hiddenEvictionTargetsRemainEligible(request.terminalIds ?? [])
          ) {
            throw new Error("hidden terminal eviction target is no longer eligible");
          }
          if (
            request.reason === "restart" &&
            request.terminalIds?.some(
              (id) =>
                !commit.coverage.some((entry) => entry.terminalId === id) ||
                commit.unresolvedTerminalIds?.includes(id),
            )
          ) {
            throw new Error("restart session checkpoint is not conclusive");
          }
          return acknowledgeSessionCheckpoint(request.requestId, commit.checkpointCommitId);
        })
        .catch((cause: unknown) => {
          if (updating && !nativePreparing) setPreparingUpdate(false);
          return acknowledgeSessionCheckpoint(
            request.requestId,
            undefined,
            cause instanceof Error ? cause.message : String(cause),
          );
        })
        .catch((error) => {
          console.warn("[session-checkpoint] Failed to acknowledge native request:", error);
        });
    })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        console.warn("[session-checkpoint] Failed to subscribe to native requests:", error);
      });

    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
      if (
        state.workspaces !== previous.workspaces ||
        state.layouts !== previous.layouts ||
        state.workspaceDisplayOrder !== previous.workspaceDisplayOrder ||
        state.activeWorkspaceId !== previous.activeWorkspaceId
      ) {
        markSessionCheckpointMutation();
      }
      if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
        void persistSession({ reason: "workspaceEntry" });
        scheduleWorkspaceEntryCatchUp();
      }
    });
    const unsubscribeDock = useDockStore.subscribe((state, previous) => {
      if (state.docks !== previous.docks) markSessionCheckpointMutation();
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
      if (state !== previous) markSessionCheckpointMutation();
    });
    const unsubscribeViewer = useFileViewerStore.subscribe((state, previous) => {
      if (
        state.open !== previous.open ||
        state.path !== previous.path ||
        state.maximized !== previous.maximized
      ) {
        markSessionCheckpointMutation();
        void persistSession({ reason: "mutation" });
      }
    });
    const checkpointWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void persistSession({ reason: "workspaceEntry" });
        scheduleWorkspaceEntryCatchUp();
      }
    };
    document.addEventListener("visibilitychange", checkpointWhenVisible);
    scheduleWorkspaceEntryCatchUp();

    return () => {
      cancelled = true;
      if (workspaceEntryTimer) clearTimeout(workspaceEntryTimer);
      unlisten?.();
      stopUpdate?.();
      unsubscribeWorkspace();
      unsubscribeDock();
      unsubscribeSettings();
      unsubscribeViewer();
      document.removeEventListener("visibilitychange", checkpointWhenVisible);
    };
  }, [ready]);
}
