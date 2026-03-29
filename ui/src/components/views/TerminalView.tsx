import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  createTerminalSession,
  writeToTerminal,
  resizeTerminal,
  closeTerminalSession,
  onTerminalOutput,
  smartPaste,
  clipboardWriteText,
  setTerminalCwdReceive,
  updateTerminalSyncGroup,
  openExternal,
} from "@/lib/tauri-api";
import {
  colorSchemeToXtermTheme,
  type WTColorScheme,
} from "@/lib/color-scheme";
import { processOscInOutput } from "@/hooks/useOscHooks";
import { getPresetHooks } from "@/lib/osc-presets";
import type { OscHook } from "@/lib/osc-parser";
import { isLxShortcut } from "@/lib/lx-shortcuts";

import { detectActivityFromTitle, detectActivityFromCommand, detectClaudeTaskTransition, extractClaudeTaskDesc, getClaudeCompletionMessage } from "@/lib/activity-detection";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { OutputIdleDetector } from "@/lib/output-idle-detector";

/** Default silence timeout for output idle detection (ms). */
const OUTPUT_IDLE_TIMEOUT_MS = 5000;

/** Resolve the workspace ID for a terminal instance (for notifications). */
function resolveWorkspaceId(terminalId: string): string {
  const inst = useTerminalStore.getState().instances.find((i) => i.id === terminalId);
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
  if (inst?.workspaceId) return inst.workspaceId;
  // Fall back: find workspace by syncGroup name match
  if (inst?.syncGroup) {
    const ws = workspaces.find((w) => w.name === inst.syncGroup);
    if (ws) return ws.id;
  }
  return activeWorkspaceId;
}

interface TerminalViewProps {
  instanceId: string;
  profile: string;
  syncGroup: string;
  cwdSend?: boolean;
  cwdReceive?: boolean;
  workspaceId?: string;
  isFocused?: boolean;
  /** Called when user starts typing — parent can hide control bar / hover state. */
  onKeyboardActivity?: () => void;
}

export function TerminalView({
  instanceId,
  profile,
  syncGroup,
  cwdSend = true,
  cwdReceive = true,
  workspaceId = "",
  isFocused = false,
  onKeyboardActivity,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const openedRef = useRef(false);
  const isFocusedRef = useRef(isFocused);
  const onKeyboardActivityRef = useRef(onKeyboardActivity);
  onKeyboardActivityRef.current = onKeyboardActivity;
  isFocusedRef.current = isFocused;
  const syncGroupRef = useRef(syncGroup);
  syncGroupRef.current = syncGroup;
  const cwdSendRef = useRef(cwdSend);
  cwdSendRef.current = cwdSend;
  const cwdReceiveRef = useRef(cwdReceive);
  cwdReceiveRef.current = cwdReceive;
  const registerInstance = useTerminalStore((s) => s.registerInstance);
  const unregisterInstance = useTerminalStore((s) => s.unregisterInstance);

  useEffect(() => {
    registerInstance({ id: instanceId, profile, syncGroup, workspaceId });

    // Resolve theme from settings color scheme (profile → profileDefaults → none)
    const settingsState = useSettingsStore.getState();
    const profileConfig = settingsState.profiles.find(
      (p) => p.name === profile,
    );
    const schemeName = profileConfig?.colorScheme
      || settingsState.profileDefaults?.colorScheme
      || "CampbellClear";
    const colorScheme = schemeName
      ? settingsState.colorSchemes.find((cs) => cs.name === schemeName)
      : undefined;

    const defaultTheme = {
      background: "#0C0C0C",
      foreground: "#F0F0F0",
      cursor: "#FFFFFF",
      selectionBackground: "#232042",
    };

    const theme = colorScheme
      ? {
          ...defaultTheme,
          ...colorSchemeToXtermTheme(colorScheme as unknown as WTColorScheme),
        }
      : defaultTheme;

    // Scrollbar overlay mode: set overviewRuler width to 0 so FitAddon
    // does not reserve space for the scrollbar — it renders on top of content.
    const sbStyle = settingsState.convenience.scrollbarStyle ?? "overlay";
    const overviewRulerWidth = sbStyle === "overlay" ? 0 : 14;

    const resolvedFont = settingsState.resolveFont(profile);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: resolvedFont.size,
      fontFamily: `'${resolvedFont.face}', 'Cascadia Mono', 'Consolas', monospace`,
      theme,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      overviewRuler: { width: overviewRulerWidth },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      openExternal(uri).catch(() => {});
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminalRef.current = terminal;

    // Custom key event handler: IDE shortcuts + smart paste interception.
    // Returning false prevents xterm from consuming the event.
    terminal.attachCustomKeyEventHandler((e) => {
      if (isLxShortcut(e)) return false;

      // Smart paste: intercept Ctrl+V / Ctrl+Shift+V on keydown
      if (
        e.type === "keydown" &&
        (e.key === "v" || e.key === "V") &&
        e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        const { convenience } = useSettingsStore.getState();
        if (convenience.smartPaste) {
          e.preventDefault();

          // Rust reads clipboard (files, images, or text) and returns result.
          // Use terminal.paste() to support bracketed paste mode — without it,
          // multi-line paste executes each line as a separate command.
          smartPaste(convenience.pasteImageDir, profile)
            .then((result) => {
              if (result.pasteType !== "none" && result.content) {
                terminal.paste(result.content);
              }
            })
            .catch(() => {}); // clipboard read failed — silently ignore

          return false; // Block xterm from processing Ctrl+V
        }
      }

      return true;
    });

    // Hide mouse cursor + control bar when user starts typing.
    // Two listeners needed: terminal.onKey for when xterm has focus (normal typing),
    // DOM keydown for when focus is elsewhere (e.g., after clicking control bar).
    const outerEl = containerRef.current?.parentElement;
    terminal.onKey(() => {
      onKeyboardActivityRef.current?.();
    });
    const handleKeyDown = () => {
      if (outerEl) outerEl.style.cursor = "none";
      onKeyboardActivityRef.current?.();
    };
    const handleMouseMove = () => {
      if (outerEl) outerEl.style.cursor = "";
    };
    outerEl?.addEventListener("keydown", handleKeyDown);
    outerEl?.addEventListener("mousemove", handleMouseMove);

    // Copy-on-select: auto-copy to clipboard when text is selected
    terminal.onSelectionChange(() => {
      const { convenience: conv } = useSettingsStore.getState();
      if (conv.copyOnSelect && terminal.hasSelection()) {
        clipboardWriteText(terminal.getSelection()).catch(() => {});
      }
    });

    // Handle terminal data (user input) — send to backend PTY
    terminal.onData((data) => {
      writeToTerminal(instanceId, data).catch(() => {});
    });

    // Handle terminal resize — notify backend PTY
    terminal.onResize(({ cols, rows }) => {
      resizeTerminal(instanceId, cols, rows).catch(() => {});
    });

    // Claude task transition state — tracked from both onTitleChange (garbled encoding)
    // and raw PTY output (correct UTF-8 via stream decoder).
    let previousClaudeTitle: string | undefined;

    // Track terminal title changes (OSC 0/2) for interactive app detection + Claude transitions
    terminal.onTitleChange((title) => {
      const { updateInstanceInfo, instances } = useTerminalStore.getState();
      const instance = instances.find((i) => i.id === instanceId);
      const detected = detectActivityFromTitle(title);
      const currentActivity = detected ?? instance?.activity;

      // Claude task transition (handles garbled encoding from xterm.js)
      const prevTitle = previousClaudeTitle ?? instance?.title;
      const transition = detectClaudeTaskTransition(prevTitle, title, currentActivity);
      previousClaudeTitle = title;

      updateInstanceInfo(instanceId, {
        title,
        ...(detected ? { activity: detected } : {}),
      });

      if (transition === "completed") {
        updateInstanceInfo(instanceId, { lastExitCode: 0, lastCommandAt: Date.now() });
        const message = getClaudeCompletionMessage(prevTitle, title);
        const wsId = resolveWorkspaceId(instanceId);
        useNotificationStore.getState().addNotification({
          terminalId: instanceId, workspaceId: wsId, message, level: "success",
        });
      } else if (transition === "started") {
        const taskDesc = extractClaudeTaskDesc(title);
        updateInstanceInfo(instanceId, {
          lastCommand: taskDesc || "Claude task", lastExitCode: undefined, lastCommandAt: Date.now(),
        });
      }
    });

    // Build hooks list
    const hooks: OscHook[] = [
      ...getPresetHooks("sync-cwd"),
      ...getPresetHooks("set-wsl-distro"),
      ...getPresetHooks("sync-branch"),
      ...getPresetHooks("notify-on-fail"),
      ...getPresetHooks("notify-on-complete"),
      ...getPresetHooks("set-title-cwd"),
      ...getPresetHooks("notify-osc9"),
      ...getPresetHooks("notify-osc99"),
      ...getPresetHooks("notify-osc777"),
      ...getPresetHooks("track-command"),
      ...getPresetHooks("track-command-result"),
      ...getPresetHooks("track-command-start"),
    ];

    // Output idle detector (monitor-silence): fires when terminal output
    // stops for OUTPUT_IDLE_TIMEOUT_MS while activity is "running".
    const idleDetector = new OutputIdleDetector(OUTPUT_IDLE_TIMEOUT_MS, () => {
      const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
      // Only fire for "running" activity (not shell, not Claude/interactive apps)
      if (inst?.activity?.type !== "running") return;
      // Mark command as completed
      useTerminalStore.getState().updateInstanceInfo(instanceId, {
        lastExitCode: 0,
        lastCommandAt: Date.now(),
        activity: { type: "shell" },
      });
      const wsId = resolveWorkspaceId(instanceId);
      const cmdDesc = inst.lastCommand || "Command";
      useNotificationStore.getState().addNotification({
        terminalId: instanceId,
        workspaceId: wsId,
        message: `${cmdDesc} completed`,
        level: "success",
      });
    });

    // Persistent TextDecoder with stream mode to handle UTF-8 characters
    // split across PTY output chunks (e.g., ✳ = E2 9C B3 may arrive as two chunks).
    const streamDecoder = new TextDecoder("utf-8", { fatal: false });

    // Listen for terminal output from backend PTY
    let cancelled = false;
    let unlistenOutput: (() => void) | undefined;
    let inAltScreen = false;
    onTerminalOutput(instanceId, (data) => {
      if (cancelled) return;
      terminal.write(data);
      const text = streamDecoder.decode(data, { stream: true });
      processOscInOutput(text, hooks, instanceId, syncGroupRef.current, {
        skipSyncCwd: !cwdSendRef.current,
      });

      // Claude task detection from raw OSC 0 titles (bypasses xterm.js encoding issues)
      const osc0Matches = text.match(/\x1b\]0;([^\x07]*)\x07/g);
      if (osc0Matches) {
        for (const oscStr of osc0Matches) {
          const titleMatch = oscStr.match(/\x1b\]0;([^\x07]*)\x07/);
          if (!titleMatch) continue;
          const rawTitle = titleMatch[1];
          const inst0 = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
          const currentActivity = inst0?.activity;
          const prevTitle = previousClaudeTitle;
          const transition = detectClaudeTaskTransition(prevTitle, rawTitle, currentActivity);
          previousClaudeTitle = rawTitle;

          if (transition === "completed") {
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              lastExitCode: 0,
              lastCommandAt: Date.now(),
            });
            const message = getClaudeCompletionMessage(prevTitle, rawTitle);
            const wsId = resolveWorkspaceId(instanceId);
            useNotificationStore.getState().addNotification({
              terminalId: instanceId,
              workspaceId: wsId,
              message,
              level: "success",
            });
          } else if (transition === "started") {
            const taskDesc = extractClaudeTaskDesc(rawTitle);
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              lastCommand: taskDesc || "Claude task",
              lastExitCode: undefined,
              lastCommandAt: Date.now(),
            });
          }
        }
      }

      // Feed idle detector on every output chunk
      const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
      if (inst?.activity?.type === "running") {
        idleDetector.recordOutput();
      }

      // Detect alt screen buffer switch (vim, nano, htop, less, etc.)
      const enterAlt = text.includes("\x1b[?1049h") || text.includes("\x1b[?47h") || text.includes("\x1b[?1047h");
      const leaveAlt = text.includes("\x1b[?1049l") || text.includes("\x1b[?47l") || text.includes("\x1b[?1047l");
      if (enterAlt && !leaveAlt && !inAltScreen) {
        inAltScreen = true;
        // Parse OSC 133;E directly from the same output chunk (sync, no IPC race)
        const cmdMatch = text.match(/\x1b\]133;E;([^\x07]*)\x07/);
        const cmdActivity = cmdMatch ? detectActivityFromCommand(cmdMatch[1]) : undefined;
        if (cmdActivity) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, { activity: cmdActivity });
        } else {
          const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
          if (inst?.activity?.type === "interactiveApp" && inst.activity.name !== "app") {
            // Already identified — don't overwrite
          } else {
            const detected = detectActivityFromTitle(inst?.title ?? "");
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              activity: detected ?? { type: "interactiveApp", name: "app" },
            });
          }
        }
      } else if (leaveAlt && !enterAlt && inAltScreen) {
        inAltScreen = false;
        useTerminalStore.getState().updateInstanceInfo(instanceId, {
          activity: { type: "shell" },
        });
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenOutput = unlisten;
      }
    });

    // Right-click: copy selection or paste (no context menu in terminal)
    const outerContainer = containerRef.current?.parentElement;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (terminal.hasSelection()) {
        // Selection exists → copy to clipboard via Tauri, then clear
        clipboardWriteText(terminal.getSelection()).catch(() => {});
        terminal.clearSelection();
      } else {
        // No selection → paste directly to PTY (no bracketed paste = no paste highlight block)
        const { convenience: conv } = useSettingsStore.getState();
        smartPaste(conv.pasteImageDir, profile)
          .then((result) => {
            if (result.pasteType !== "none" && result.content) {
              writeToTerminal(instanceId, result.content);
            }
          })
          .catch(() => {});
      }
    };
    outerContainer?.addEventListener("contextmenu", handleContextMenu);

    // Ctrl+Wheel: zoom font size (up = bigger, down = smaller)
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const state = useSettingsStore.getState();
      const currentFont = state.resolveFont(profile);
      const delta = e.deltaY < 0 ? 1 : -1;
      const newSize = Math.max(6, Math.min(72, currentFont.size + delta));
      if (newSize !== currentFont.size) {
        // Update the profile's font override
        const idx = state.profiles.findIndex((p) => p.name === profile);
        if (idx >= 0) {
          state.updateProfile(idx, { font: { ...currentFont, size: newSize } });
        }
      }
    };
    outerContainer?.addEventListener("wheel", handleWheel, { passive: false });

    // Wait for container to have actual dimensions before opening terminal.
    // xterm.js viewport gets height 0 if opened in a zero-sized container,
    // causing rendering artifacts (garbled first row).
    let sessionCreated = false;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0 && !sessionCreated) {
        sessionCreated = true;
        // Open terminal now that container has real dimensions
        if (containerRef.current) {
          terminal.open(containerRef.current);
        }
        // WebGL renderer required for custom glyph drawing (box-drawing, block
        // elements). xterm.js v6 built-in renderer does not support customGlyphs.
        try {
          const webgl = new WebglAddon(true); // preserveDrawingBuffer for screenshots
          terminal.loadAddon(webgl);
          webgl.onContextLoss(() => webgl.dispose());
        } catch {
          // WebGL not available — fall back to default renderer
        }
        fitAddon.fit();
        openedRef.current = true;
        if (isFocusedRef.current) {
          terminal.focus();
        }
        createTerminalSession(
          instanceId,
          profile,
          terminal.cols,
          terminal.rows,
          syncGroup,
        ).then(() => {
          setTerminalCwdReceive(instanceId, cwdReceiveRef.current).catch(() => {});
        }).catch(() => {});
      } else if (sessionCreated && width > 0 && height > 0) {
        fitAddon.fit();
      }
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelled = true;
      idleDetector.dispose();
      resizeObserver.disconnect();
      outerContainer?.removeEventListener("contextmenu", handleContextMenu);
      outerContainer?.removeEventListener("wheel", handleWheel);
      outerEl?.removeEventListener("keydown", handleKeyDown);
      outerEl?.removeEventListener("mousemove", handleMouseMove);
      unlistenOutput?.();
      closeTerminalSession(instanceId).catch(() => {});
      terminal.dispose();
      unregisterInstance(instanceId);
    };
  // syncGroup intentionally excluded: changes (e.g. workspace rename) must NOT
  // destroy/recreate the terminal session. syncGroupRef is used at runtime instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, profile, registerInstance, unregisterInstance]);

  // Lightweight update when syncGroup changes — no terminal recreation
  useEffect(() => {
    useTerminalStore.getState().updateInstanceInfo(instanceId, { syncGroup });
    updateTerminalSyncGroup(instanceId, syncGroup).catch(() => {});
  }, [instanceId, syncGroup]);

  // Update backend when cwdReceive changes
  useEffect(() => {
    setTerminalCwdReceive(instanceId, cwdReceive).catch(() => {});
  }, [instanceId, cwdReceive]);

  // Focus/blur terminal when pane focus state changes (only if terminal is opened)
  useEffect(() => {
    if (openedRef.current) {
      if (isFocused) {
        terminalRef.current?.focus();
      } else {
        terminalRef.current?.blur();
      }
    }
  }, [isFocused]);

  // Reactively update terminal theme when profile colorScheme or font changes
  const currentSchemeName = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return prof?.colorScheme || s.profileDefaults?.colorScheme || "CampbellClear";
  });
  const colorSchemes = useSettingsStore((s) => s.colorSchemes ?? []);
  const font = useSettingsStore((s) => s.resolveFont(profile));

  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.options) return;

    const scheme = currentSchemeName
      ? colorSchemes.find((cs) => cs.name === currentSchemeName)
      : undefined;

    const defaultTheme = {
      background: "#0C0C0C",
      foreground: "#F0F0F0",
      cursor: "#FFFFFF",
      selectionBackground: "#232042",
    };

    try {
      term.options.theme = scheme
        ? { ...defaultTheme, ...colorSchemeToXtermTheme(scheme as unknown as WTColorScheme) }
        : defaultTheme;
      term.options.fontSize = font.size;
      term.options.fontFamily = `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
    } catch { /* xterm mock may not support options setter */ }
  }, [currentSchemeName, colorSchemes, font]);

  // Resolve terminal background for padding area
  const termBg = (() => {
    const scheme = currentSchemeName
      ? colorSchemes.find((cs) => cs.name === currentSchemeName)
      : undefined;
    return scheme?.background || "#1e1e2e";
  })();

  // Read padding from profile settings
  const padding = useSettingsStore(
    (s) => s.profiles.find((p) => p.name === profile)?.padding,
  );
  const pt = padding?.top ?? 8;
  const pr = padding?.right ?? 8;
  const pb = padding?.bottom ?? 8;
  const pl = padding?.left ?? 8;

  // Scrollbar style: overlay (default) renders on top of terminal content,
  // separate reserves space for the scrollbar.
  const scrollbarStyle = useSettingsStore(
    (s) => s.convenience.scrollbarStyle ?? "overlay",
  );
  const scrollbarClass = scrollbarStyle === "overlay" ? "scrollbar-overlay" : "scrollbar-separate";

  return (
    <div
      data-testid={`terminal-view-${instanceId}`}
      className={`h-full w-full ${scrollbarClass}`}
      style={{
        background: termBg,
        padding: `${pt}px ${pr}px ${pb}px ${pl}px`,
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
