import { useEffect } from "react";

import { acknowledgeSessionCheckpoint, onSessionCheckpointRequested } from "@/lib/tauri-api";
import {
  flushSessionCheckpoint,
  markSessionCheckpointMutation,
  persistSession,
} from "@/lib/persist-session";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { SESSION_ATTRIBUTION_STARTUP_GRACE_MS } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** Connect native watchdog/update barriers and workspace-entry hints to one coordinator. */
export function useSessionCheckpointLifecycle(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let workspaceEntryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleWorkspaceEntryCatchUp = () => {
      if (workspaceEntryTimer) clearTimeout(workspaceEntryTimer);
      workspaceEntryTimer = setTimeout(() => {
        void persistSession({ reason: "workspaceEntry" });
      }, SESSION_ATTRIBUTION_STARTUP_GRACE_MS);
    };

    void onSessionCheckpointRequested((request) => {
      if (cancelled) return;
      void flushSessionCheckpoint({
        reason: request.reason,
        requireConclusive: request.requireConclusive,
      })
        .then((commit) =>
          acknowledgeSessionCheckpoint(request.requestId, commit.checkpointCommitId),
        )
        .catch((cause: unknown) =>
          acknowledgeSessionCheckpoint(
            request.requestId,
            undefined,
            cause instanceof Error ? cause.message : String(cause),
          ),
        )
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
        state.workspaceDisplayOrder !== previous.workspaceDisplayOrder
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
      unsubscribeWorkspace();
      unsubscribeDock();
      unsubscribeSettings();
      document.removeEventListener("visibilitychange", checkpointWhenVisible);
    };
  }, [ready]);
}
