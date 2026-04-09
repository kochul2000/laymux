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
  onTerminalOutputActivity,
  markClaudeTerminal,
} from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";
import { sendDesktopNotification } from "./useOsNotification";
import { detectActivityFromCommand } from "@/lib/activity-detection";
import { getHandler, type RawTerminalState } from "@/lib/activity-handler";

const CWD_PERSIST_DEBOUNCE_MS = 2000;
const OUTPUT_ACTIVE_RESET_MS = 2000;

export function useSyncEvents() {
  const cwdPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputActiveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const debouncedPersistCwd = useCallback(() => {
    if (cwdPersistTimerRef.current) clearTimeout(cwdPersistTimerRef.current);
    cwdPersistTimerRef.current = setTimeout(() => {
      persistSession();
    }, CWD_PERSIST_DEBOUNCE_MS);
  }, []);

  const resetOutputActiveSoon = useCallback((terminalId: string) => {
    const prev = outputActiveTimers.current.get(terminalId);
    if (prev) clearTimeout(prev);
    outputActiveTimers.current.set(
      terminalId,
      setTimeout(() => {
        useTerminalStore.getState().updateInstanceInfo(terminalId, { outputActive: false });
        outputActiveTimers.current.delete(terminalId);
      }, OUTPUT_ACTIVE_RESET_MS),
    );
  }, []);

  const clearOutputActive = useCallback((terminalId: string) => {
    useTerminalStore.getState().updateInstanceInfo(terminalId, { outputActive: false });
    const timer = outputActiveTimers.current.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      outputActiveTimers.current.delete(terminalId);
    }
  }, []);

  const markOutputActive = useCallback(
    (terminalId: string) => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, { outputActive: true });
      resetOutputActiveSoon(terminalId);
    },
    [resetOutputActiveSoon],
  );

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

    trackListener(
      onClaudeTerminalDetected((terminalId) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        if (instances.some((i) => i.id === terminalId)) {
          updateInstanceInfo(terminalId, {
            activity: { type: "interactiveApp", name: "Claude" },
          });
        }
      }),
    );

    trackListener(
      onClaudeMessageChanged((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          activityMessage: data.message,
        });
      }),
    );

    trackListener(
      onTerminalOutputActivity((data) => {
        if (cancelled) return;
        if (data.active === false) {
          clearOutputActive(data.terminalId);
          return;
        }
        markOutputActive(data.terminalId);
      }),
    );

    trackListener(
      onTerminalTitleChanged((data) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const instance = instances.find((i) => i.id === data.terminalId);
        const detectedActivity = data.interactiveApp
          ? ({ type: "interactiveApp", name: data.interactiveApp } as const)
          : undefined;
        const currentActivity = instance?.activity;
        const handler = getHandler(detectedActivity ?? currentActivity);
        const raw: RawTerminalState = {
          exitCode: instance?.lastExitCode,
          outputActive: instance?.outputActive ?? false,
          lastCommand: instance?.lastCommand,
          activityMessage: instance?.activityMessage,
          activity: detectedActivity ?? currentActivity,
          title: data.title,
        };

        const updates: Record<string, unknown> = { title: data.title };
        if (detectedActivity) {
          updates.activity = detectedActivity;
        } else if (
          currentActivity?.type === "interactiveApp" &&
          !handler.shouldPreserveActivityOnTitleReset?.(raw)
        ) {
          updates.activity = { type: "shell" };
        }

        updateInstanceInfo(data.terminalId, updates as Parameters<typeof updateInstanceInfo>[1]);

        if (handler.isActiveTitle?.(data.title)) {
          markOutputActive(data.terminalId);
        }
      }),
    );

    trackListener(
      onTerminalCwdChanged((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          cwd: data.cwd,
        });
        debouncedPersistCwd();
      }),
    );

    trackListener(
      onSyncCwd((data) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const targetSet = new Set(data.targets);
        if (instances.find((i) => i.id === data.terminalId)) {
          targetSet.add(data.terminalId);
        }
        for (const targetId of targetSet) {
          updateInstanceInfo(targetId, { cwd: data.path });
        }
        debouncedPersistCwd();
      }),
    );

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

    trackListener(
      onLxNotify((data) => {
        if (cancelled) return;
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
        const ideFocused = document.hasFocus();
        if (!ideFocused || activeWorkspaceId !== targetWsId) {
          sendDesktopNotification("Laymux", data.message);
        }
      }),
    );

    trackListener(
      onSetTabTitle((data) => {
        if (cancelled) return;
        useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
          title: data.title,
        });
      }),
    );

    trackListener(
      onCommandStatus((data) => {
        if (cancelled) return;
        const update: Record<string, unknown> = {};

        if (data.command !== undefined && data.command !== "__preexec__") {
          update.lastCommand = data.command;
          update.lastCommandAt = Date.now();
          const appActivity = detectActivityFromCommand(data.command);
          if (appActivity) {
            update.activity = appActivity;
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
          const instance = useTerminalStore
            .getState()
            .instances.find((i) => i.id === data.terminalId);
          if (!instance?.activity || instance.activity.type !== "interactiveApp") {
            update.activity = { type: "shell" };
          } else {
            const handler = getHandler(instance.activity);
            const raw: RawTerminalState = {
              exitCode: data.exitCode,
              outputActive: instance.outputActive ?? false,
              lastCommand: instance.lastCommand,
              activityMessage: instance.activityMessage,
              activity: instance.activity,
              title: instance.title,
            };
            if (!handler.shouldPreserveActivityOnExitCode?.(raw)) {
              update.activity = { type: "shell" };
            }
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

    const unsubStore = useTerminalStore.subscribe((state, prevState) => {
      if (state.instances.length < prevState.instances.length) {
        const currentIds = new Set(state.instances.map((i) => i.id));
        for (const [id, timer] of outputActiveTimers.current) {
          if (!currentIds.has(id)) {
            clearTimeout(timer);
            outputActiveTimers.current.delete(id);
          }
        }
      }
    });

    return () => {
      cancelled = true;
      unsubStore();
      if (cwdPersistTimerRef.current) clearTimeout(cwdPersistTimerRef.current);
      for (const timer of outputActiveTimers.current.values()) {
        clearTimeout(timer);
      }
      outputActiveTimers.current.clear();
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [clearOutputActive, debouncedPersistCwd, markOutputActive]);
}
