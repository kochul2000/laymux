import { useEffect } from "react";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  onSyncCwd,
  onSyncBranch,
  onLxNotify,
  onSetTabTitle,
  onCommandStatus,
} from "@/lib/tauri-api";
import { sendDesktopNotification } from "./useOsNotification";
import { detectActivityFromCommand } from "@/lib/activity-detection";

/**
 * Hook that listens for sync events from the Tauri backend
 * and updates the appropriate stores.
 */
export function useSyncEvents() {
  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    function trackListener(promise: Promise<() => void>) {
      promise.then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      });
    }

    // sync-cwd: update CWD for all targeted terminals + source
    trackListener(
      onSyncCwd((data) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const targetSet = new Set(data.targets);
        // Always include the source terminal
        if (instances.find((i) => i.id === data.terminalId)) {
          targetSet.add(data.terminalId);
        }
        for (const targetId of targetSet) {
          updateInstanceInfo(targetId, { cwd: data.path });
        }
      }),
    );

    // sync-branch: update branch for all terminals in the group
    trackListener(
      onSyncBranch((data) => {
        if (cancelled) return;
        const { instances, updateInstanceInfo } = useTerminalStore.getState();
        const groupTerminals = instances.filter(
          (i) => i.syncGroup === data.groupId,
        );
        for (const t of groupTerminals) {
          updateInstanceInfo(t.id, { branch: data.branch });
        }
      }),
    );

    // lx-notify: add notification to the workspace that owns the terminal
    trackListener(
      onLxNotify((data) => {
        if (cancelled) return;
        // Find which workspace the terminal belongs to via its syncGroup
        const instance = useTerminalStore.getState().instances.find(
          (i) => i.id === data.terminalId,
        );
        const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
        let targetWsId = activeWorkspaceId;
        if (instance?.syncGroup) {
          const ownerWs = workspaces.find((ws) => ws.id === instance.syncGroup);
          if (ownerWs) {
            targetWsId = ownerWs.id;
          }
        }
        useNotificationStore.getState().addNotification({
          terminalId: data.terminalId,
          workspaceId: targetWsId,
          message: data.message,
          level: data.level as "info" | "error" | "warning" | "success" | undefined,
        });
        // Only send OS notification when IDE is not focused or the workspace is not active
        const ideFocused = document.hasFocus();
        if (!ideFocused || activeWorkspaceId !== targetWsId) {
          sendDesktopNotification("Laymux", data.message);
        }
      }),
    );

    // set-tab-title: update terminal title
    trackListener(
      onSetTabTitle((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          title: data.title,
        });
      }),
    );

    // command-status: track last command and exit code per terminal + activity state
    trackListener(
      onCommandStatus((data) => {
        if (cancelled) return;
        const update: Record<string, unknown> = {};
        if (data.command !== undefined && data.command !== "__preexec__") {
          // Real command text from OSC 133 E
          update.lastCommand = data.command;
          update.lastCommandAt = Date.now();
          // Detect interactive app from command text (e.g. "vim file.txt" → vim)
          const appActivity = detectActivityFromCommand(data.command);
          if (appActivity) {
            update.activity = appActivity;
          } else {
            update.activity = { type: "running" };
          }
        } else if (data.command === "__preexec__") {
          // Preexec marker from OSC 133 C — don't overwrite lastCommand
          update.lastCommandAt = Date.now();
          const instance = useTerminalStore.getState().instances.find(
            (i) => i.id === data.terminalId,
          );
          if (!instance?.activity || instance.activity.type !== "interactiveApp") {
            update.activity = { type: "running" };
          }
        }
        if (data.exitCode !== undefined) {
          update.lastExitCode = data.exitCode;
          update.lastCommandAt = Date.now();
          // Command finished → shell prompt
          update.activity = { type: "shell" };
        }
        useTerminalStore.getState().updateInstanceInfo(
          data.terminalId,
          update as { lastCommand?: string; lastExitCode?: number; lastCommandAt?: number; activity?: { type: import("@/stores/terminal-store").TerminalActivityType } },
        );
      }),
    );

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);
}
