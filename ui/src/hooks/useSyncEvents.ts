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

/**
 * Hook that listens for sync events from the Tauri backend
 * and updates the appropriate stores.
 */
/** Debounce delay for persisting CWD changes to settings.json (ms). */
const CWD_PERSIST_DEBOUNCE_MS = 2000;

/** Delay before resetting outputActive to false after last DEC 2026 event (ms).
 *
 * **Coupled with backend**: must match `DEC2026_BURST_WINDOW_MS` in `constants.rs`.
 * If shorter, outputActive flickers between DEC 2026 events.
 * If longer, ⏳ persists after TUI stops rendering. */
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
          activityMessage: data.message,
        });
      }),
    );

    // terminal-output-activity: Two modes of operation:
    //   1. active=true (default, omitted): DEC 2026 burst detected → TUI is rendering frames.
    //      Sets outputActive=true + starts 2s auto-reset timer.
    //   2. active=false: Rust detected TUI working→idle transition (e.g., Claude task completion).
    //      Immediately clears outputActive — no 2s lag. This is app-agnostic: the frontend
    //      doesn't check which app triggered it. Rust's state machine decides when to emit.
    trackListener(
      onTerminalOutputActivity((data) => {
        if (cancelled) return;
        const { updateInstanceInfo } = useTerminalStore.getState();

        if (data.active === false) {
          // Immediate deactivation from Rust state machine (TUI working→idle).
          // Arrives BEFORE terminal-title-changed for the same title update,
          // so ⏳→✓ transition happens without the DEC 2026 timeout lag.
          updateInstanceInfo(data.terminalId, { outputActive: false });
          const timer = outputActiveTimers.current.get(data.terminalId);
          if (timer) {
            clearTimeout(timer);
            outputActiveTimers.current.delete(data.terminalId);
          }
          return;
        }

        updateInstanceInfo(data.terminalId, { outputActive: true });

        // Reset timer: clear outputActive after 2s of no activity
        const prev = outputActiveTimers.current.get(data.terminalId);
        if (prev) clearTimeout(prev);
        outputActiveTimers.current.set(
          data.terminalId,
          setTimeout(() => {
            if (cancelled) return;
            useTerminalStore.getState().updateInstanceInfo(data.terminalId, {
              outputActive: false,
            });
            outputActiveTimers.current.delete(data.terminalId);
          }, OUTPUT_ACTIVE_RESET_MS),
        );
      }),
    );

    // terminal-title-changed: backend PTY callback extracted OSC 0/2 title.
    // Handles activity detection and title updates.
    trackListener(
      onTerminalTitleChanged((data) => {
        if (cancelled) return;
        const { updateInstanceInfo, instances } = useTerminalStore.getState();
        const instance = instances.find((i) => i.id === data.terminalId);

        // Update title in store
        const updates: Record<string, unknown> = { title: data.title };

        // Activity detection from interactive app (Rust already detected this,
        // including known_claude_terminals fallback for spinner titles like "✢ Working").
        if (data.interactiveApp) {
          updates.activity = { type: "interactiveApp", name: data.interactiveApp };
        } else if (instance?.activity?.type === "interactiveApp") {
          // Interactive app exited — title no longer matches any app pattern.
          // Reset to shell so stale Claude/vim indicators don't persist.
          updates.activity = { type: "shell" };
        }

        updateInstanceInfo(data.terminalId, updates as Parameters<typeof updateInstanceInfo>[1]);
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

    // Clean up outputActive timers when terminals are removed from the store
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
  }, []);
}
