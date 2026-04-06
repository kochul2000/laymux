import { useEffect, useRef, useCallback } from "react";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  onSyncCwd,
  onSyncBranch,
  onLxNotify,
  onSetTabTitle,
  onCommandStatus,
  onClaudeTerminalDetected,
  onClaudeMessageChanged,
  onTerminalCwdChanged,
  onTerminalTitleChanged,
  markClaudeTerminal,
} from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";
import { sendDesktopNotification } from "./useOsNotification";
import {
  detectActivityFromCommand,
  detectClaudeTaskTransition,
  extractClaudeTaskDesc,
  getClaudeCompletionMessage,
} from "@/lib/activity-detection";
import { resolveWorkspaceId } from "@/lib/workspace-utils";

/**
 * Hook that listens for sync events from the Tauri backend
 * and updates the appropriate stores.
 */
/** Debounce delay for persisting CWD changes to settings.json (ms). */
const CWD_PERSIST_DEBOUNCE_MS = 2000;

export function useSyncEvents() {
  const cwdPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedPersistCwd = useCallback(() => {
    if (cwdPersistTimerRef.current) clearTimeout(cwdPersistTimerRef.current);
    cwdPersistTimerRef.current = setTimeout(() => {
      persistSession();
    }, CWD_PERSIST_DEBOUNCE_MS);
  }, []);

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

    // claude-terminal-detected: backend PTY callback detected Claude Code in terminal title.
    // This is the single source of truth — set activity so frontend display matches.
    trackListener(
      onClaudeTerminalDetected((terminalId) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const instance = instances.find((i) => i.id === terminalId);
        if (instance) {
          updateInstanceInfo(terminalId, {
            activity: { type: "interactiveApp", name: "Claude" },
          });
        }
      }),
    );

    // claude-message-changed: backend PTY callback extracted white-● status message.
    trackListener(
      onClaudeMessageChanged((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          claudeMessage: data.message,
        });
      }),
    );

    // terminal-title-changed: backend PTY callback extracted OSC 0/2 title.
    // This is the centralized title event — handles activity detection,
    // Claude task transitions, and title updates in one place.
    const previousClaudeTitleMap = new Map<string, string>();
    trackListener(
      onTerminalTitleChanged((data) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const instance = instances.find((i) => i.id === data.terminalId);

        // Update title in store
        const updates: Record<string, unknown> = { title: data.title };

        // Activity detection from interactive app (Rust already detected this)
        if (data.interactiveApp) {
          updates.activity = { type: "interactiveApp", name: data.interactiveApp };
        } else if (instance?.activity?.type === "interactiveApp") {
          // Interactive app exited — title no longer matches any app pattern.
          // Reset to shell so stale Claude/vim indicators don't persist.
          updates.activity = { type: "shell" };
        }

        updateInstanceInfo(data.terminalId, updates as Parameters<typeof updateInstanceInfo>[1]);

        // Claude task transition detection
        const prevTitle = previousClaudeTitleMap.get(data.terminalId) ?? instance?.title;
        const currentActivity = data.interactiveApp
          ? { type: "interactiveApp" as const, name: data.interactiveApp }
          : instance?.activity;
        const claudeExited =
          !data.interactiveApp &&
          instance?.activity?.type === "interactiveApp" &&
          instance.activity.name === "Claude";
        const transition = detectClaudeTaskTransition(
          prevTitle,
          data.title,
          currentActivity,
          claudeExited,
        );
        previousClaudeTitleMap.set(data.terminalId, data.title);

        if (transition === "completed") {
          updateInstanceInfo(data.terminalId, {
            lastCommandAt: Date.now(),
          });
          // Only emit notification when notify gate is armed (prevents shell-init spam)
          if (data.notifyGateArmed) {
            const message = getClaudeCompletionMessage(prevTitle, data.title);
            const wsId = resolveWorkspaceId(data.terminalId);
            useNotificationStore.getState().addNotification({
              terminalId: data.terminalId,
              workspaceId: wsId,
              message,
              level: "success",
            });
          }
        } else if (transition === "started") {
          const taskDesc = extractClaudeTaskDesc(data.title);
          updateInstanceInfo(data.terminalId, {
            lastCommand: taskDesc || "Claude task",
            lastCommandAt: Date.now(),
          });
        }
      }),
    );

    // terminal-cwd-changed: backend PTY callback detected CWD from OSC 7/9;9.
    // This is the single source of truth — update frontend store to match.
    trackListener(
      onTerminalCwdChanged((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          cwd: data.cwd,
        });
        debouncedPersistCwd();
      }),
    );

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
        debouncedPersistCwd();
      }),
    );

    // sync-branch: update branch for all terminals in the group
    trackListener(
      onSyncBranch((data) => {
        if (cancelled) return;
        const { instances, updateInstanceInfo } = useTerminalStore.getState();
        const groupTerminals = instances.filter((i) => i.syncGroup === data.groupId);
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
        const instance = useTerminalStore
          .getState()
          .instances.find((i) => i.id === data.terminalId);
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
            // Notify backend so known_claude_terminals (single source of truth) is updated.
            // This covers the case where the user typed "claude" but the title
            // hasn't been set yet (PTY callback hasn't seen "Claude Code" title).
            if (appActivity.name === "Claude") {
              markClaudeTerminal(data.terminalId).catch(() => {});
            }
          } else {
            const instance = useTerminalStore
              .getState()
              .instances.find((i) => i.id === data.terminalId);
            if (!instance?.activity || instance.activity.type !== "interactiveApp") {
              update.activity = { type: "running" };
            }
          }
        } else if (data.command === "__preexec__") {
          // Preexec marker from OSC 133 C — don't overwrite lastCommand
          update.lastCommandAt = Date.now();
          const instance = useTerminalStore
            .getState()
            .instances.find((i) => i.id === data.terminalId);
          if (!instance?.activity || instance.activity.type !== "interactiveApp") {
            update.activity = { type: "running" };
          }
        }
        if (data.exitCode !== undefined) {
          update.lastExitCode = data.exitCode;
          update.lastCommandAt = Date.now();
          // Command finished → shell prompt (but preserve interactiveApp state
          // so sub-command exit codes don't override Claude/vim/etc. activity)
          const instance = useTerminalStore
            .getState()
            .instances.find((i) => i.id === data.terminalId);
          if (!instance?.activity || instance.activity.type !== "interactiveApp") {
            update.activity = { type: "shell" };
          }
        }
        useTerminalStore.getState().updateInstanceInfo(
          data.terminalId,
          update as {
            lastCommand?: string;
            lastExitCode?: number;
            lastCommandAt?: number;
            activity?: { type: import("@/stores/terminal-store").TerminalActivityType };
          },
        );
      }),
    );

    return () => {
      cancelled = true;
      if (cwdPersistTimerRef.current) clearTimeout(cwdPersistTimerRef.current);
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);
}
