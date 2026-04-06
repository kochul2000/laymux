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
  markClaudeTerminal,
} from "@/lib/tauri-api";
import { colorSchemeToXtermTheme, type WTColorScheme } from "@/lib/color-scheme";
import { transformPasteContent, trimSelectionTrailingWhitespace } from "@/lib/smart-text";
import { isLxShortcut } from "@/lib/lx-shortcuts";

import { detectActivityFromTitle, detectActivityFromCommand } from "@/lib/activity-detection";
import { useNotificationStore } from "@/stores/notification-store";
import { resolveWorkspaceId } from "@/lib/workspace-utils";
import { OutputIdleDetector } from "@/lib/output-idle-detector";
import { SerializeAddon } from "@xterm/addon-serialize";
import { loadTerminalOutputCache } from "@/lib/tauri-api";
import {
  registerTerminalSerializer,
  unregisterTerminalSerializer,
} from "@/lib/terminal-serialize-registry";

/** Default silence timeout for output idle detection (ms). */
const OUTPUT_IDLE_TIMEOUT_MS = 5000;

/** Byte-size threshold for the large paste warning dialog. */
const LARGE_PASTE_THRESHOLD = 5120;

const textEncoder = new TextEncoder();

/**
 * Check if a large paste should be blocked. Returns true if the user cancelled.
 * Uses byte length (UTF-8) for consistency with PTY chunked write.
 */
function shouldBlockLargePaste(content: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const byteLength = textEncoder.encode(content).length;
  if (byteLength <= LARGE_PASTE_THRESHOLD) return false;
  return !window.confirm(
    `붙여넣을 텍스트가 ${byteLength.toLocaleString()}바이트입니다. 계속하시겠습니까?`,
  );
}

/** Notify gate fallback timeout — only used for output idle detector gating. */
const NOTIFY_GATE_FALLBACK_MS = 3000;

// Stagger WebGL context creation to prevent WebView2 GPU process crash.
// Multiple simultaneous WebGL inits can trigger ACCESS_VIOLATION in msedge.dll.
let webglInitCount = 0;
const WEBGL_STAGGER_MS = 150;

/** Reset the stagger counter (for tests). */
export function _resetWebglStagger(): void {
  webglInitCount = 0;
}

interface TerminalViewProps {
  instanceId: string;
  paneId?: string;
  profile: string;
  syncGroup: string;
  cwdSend?: boolean;
  cwdReceive?: boolean;
  workspaceId?: string;
  isFocused?: boolean;
  /** Called when user starts typing — parent can hide control bar / hover state. */
  onKeyboardActivity?: () => void;
  /** Last CWD from previous session, used for restore on startup. */
  lastCwd?: string;
  /** Claude Code session ID from previous session, used for --resume on startup. */
  lastClaudeSession?: string;
  /** Override the startup command (takes precedence over Claude session restore). */
  startupCommandOverride?: string;
}

export function TerminalView({
  instanceId,
  paneId,
  profile,
  syncGroup,
  cwdSend = true,
  cwdReceive = true,
  workspaceId = "",
  isFocused = false,
  onKeyboardActivity,
  lastCwd,
  lastClaudeSession,
  startupCommandOverride,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
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
    const profileConfig = settingsState.profiles.find((p) => p.name === profile);
    const schemeName =
      profileConfig?.colorScheme || settingsState.profileDefaults?.colorScheme || "CampbellClear";
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
      scrollback: 10000,
      windowsPty: { backend: "conpty", buildNumber: 21376 },
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
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
                const content = transformPasteContent(result.content, result.pasteType, {
                  removeIndent: convenience.smartRemoveIndent,
                  removeLineBreak: convenience.smartRemoveLineBreak,
                });
                if (shouldBlockLargePaste(content, convenience.largePasteWarning)) {
                  return;
                }
                terminal.paste(content);
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
      if (outerEl) outerEl.style.cursor = "none";
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
        clipboardWriteText(trimSelectionTrailingWhitespace(terminal.getSelection())).catch(
          () => {},
        );
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

    // Track terminal title changes (OSC 0/2) for interactive app detection.
    // Claude task transitions and notifications are now handled by the Rust
    // PTY callback via structured events (terminal-title-changed, lx-notify).
    // xterm.js onTitleChange is kept as a lightweight fallback for activity detection.
    terminal.onTitleChange((title) => {
      const { updateInstanceInfo } = useTerminalStore.getState();
      const detected = detectActivityFromTitle(title);

      updateInstanceInfo(instanceId, {
        title,
        ...(detected ? { activity: detected } : {}),
      });
    });

    // Notify gate for output idle detector only — OSC notifications are now
    // handled entirely in Rust. This gate controls whether the idle detector
    // can emit "completed" notifications.
    const notifyGate = { armed: false };
    const notifyGateTimer = setTimeout(() => {
      notifyGate.armed = true;
    }, NOTIFY_GATE_FALLBACK_MS);

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
      if (notifyGate.armed) {
        useNotificationStore.getState().addNotification({
          terminalId: instanceId,
          workspaceId: wsId,
          message: `${cmdDesc} completed`,
          level: "success",
        });
      }
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

      // OSC parsing and hook dispatch are now handled entirely in the Rust
      // PTY callback (iter_osc_events + match_hooks + dispatch_osc_action).
      // The frontend only needs to handle alt-screen detection and idle monitoring.

      // Feed idle detector on every output chunk
      const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
      if (inst?.activity?.type === "running") {
        idleDetector.recordOutput();
      }

      // Detect alt screen buffer switch (vim, nano, htop, less, etc.)
      const enterAlt =
        text.includes("\x1b[?1049h") || text.includes("\x1b[?47h") || text.includes("\x1b[?1047h");
      const leaveAlt =
        text.includes("\x1b[?1049l") || text.includes("\x1b[?47l") || text.includes("\x1b[?1047l");
      if (enterAlt && !leaveAlt && !inAltScreen) {
        inAltScreen = true;
        // Parse OSC 133;E directly from the same output chunk (sync, no IPC race)
        const cmdMatch = text.match(/\x1b\]133;E;([^\x07]*)\x07/);
        const cmdActivity = cmdMatch ? detectActivityFromCommand(cmdMatch[1]) : undefined;
        if (cmdActivity) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, { activity: cmdActivity });
          if (cmdActivity.name === "Claude") {
            markClaudeTerminal(instanceId).catch(() => {});
          }
        } else {
          const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
          if (inst?.activity?.type === "interactiveApp" && inst.activity.name !== "app") {
            // Already identified — don't overwrite
          } else {
            const detected = detectActivityFromTitle(inst?.title ?? "");
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              activity: detected ?? { type: "interactiveApp", name: "app" },
            });
            if (detected?.name === "Claude") {
              markClaudeTerminal(instanceId).catch(() => {});
            }
          }
        }
      } else if (leaveAlt && !enterAlt && inAltScreen) {
        inAltScreen = false;
        // If leaving an interactive app (Claude, vim, etc.), clear stale command state
        // so WorkspaceSelectorView does not show leftover info after the app exits.
        const prevInst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
        if (prevInst?.activity?.type === "interactiveApp") {
          useTerminalStore.getState().clearCommandState(instanceId);
        }
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
        clipboardWriteText(trimSelectionTrailingWhitespace(terminal.getSelection())).catch(
          () => {},
        );
        terminal.clearSelection();
      } else {
        // No selection → paste via terminal.paste() (same as Ctrl+V for bracketed paste support)
        const { convenience: conv } = useSettingsStore.getState();
        smartPaste(conv.pasteImageDir, profile)
          .then((result) => {
            if (result.pasteType !== "none" && result.content) {
              const content = transformPasteContent(result.content, result.pasteType, {
                removeIndent: conv.smartRemoveIndent,
                removeLineBreak: conv.smartRemoveLineBreak,
              });
              if (shouldBlockLargePaste(content, conv.largePasteWarning)) {
                return;
              }
              terminal.paste(content);
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
    let webglTimer: ReturnType<typeof setTimeout> | undefined;
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
        // Stagger creation to prevent simultaneous GPU context init crash.
        const delay = webglInitCount * WEBGL_STAGGER_MS;
        webglInitCount++;
        webglTimer = setTimeout(() => {
          if (cancelled) return;
          try {
            const webgl = new WebglAddon(true); // preserveDrawingBuffer for screenshots
            terminal.loadAddon(webgl);
            webgl.onContextLoss(() => webgl.dispose());
          } catch {
            // WebGL not available — fall back to default renderer
          }
        }, delay);
        // Load SerializeAddon for session persistence
        const serializeAddon = new SerializeAddon();
        terminal.loadAddon(serializeAddon);

        // Register serializer for shutdown save
        if (paneId) {
          registerTerminalSerializer(paneId, () => serializeAddon.serialize());
        }

        fitAddon.fit();
        openedRef.current = true;
        if (isFocusedRef.current) {
          terminal.focus();
        }

        // Resolve profile restore settings and create session (async)
        const profileConfig = settingsState.profiles.find((p) => p.name === profile);
        const shouldRestoreCwd =
          profileConfig?.restoreCwd ?? settingsState.profileDefaults.restoreCwd;
        const shouldRestoreOutput =
          profileConfig?.restoreOutput ?? settingsState.profileDefaults.restoreOutput;

        // Determine startup command override for Claude session restore.
        // Validate session ID format to prevent command injection.
        const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
        const shouldRestoreClaudeSession = settingsState.claude?.restoreSession !== false;
        const safeSessionId =
          lastClaudeSession && SESSION_ID_PATTERN.test(lastClaudeSession)
            ? lastClaudeSession
            : undefined;
        const startupOverride = startupCommandOverride
          ? startupCommandOverride
          : shouldRestoreClaudeSession && safeSessionId
            ? `claude --resume ${safeSessionId}`
            : undefined;

        // Start PTY session immediately (don't wait for cache restore).
        // Cache restore runs in parallel so the shell starts booting ASAP.
        if (!cancelled) {
          createTerminalSession(
            instanceId,
            profile,
            terminal.cols,
            terminal.rows,
            syncGroup,
            cwdReceiveRef.current,
            shouldRestoreCwd ? lastCwd : undefined,
            startupOverride,
          ).catch((err) => {
            console.error(`[TerminalView] Failed to create session ${instanceId}:`, err);
            terminal.write(`\r\n\x1b[31mFailed to create terminal session: ${err}\x1b[0m\r\n`);
          });
        }

        // Restore cached terminal output in parallel (non-blocking).
        if (shouldRestoreOutput && paneId) {
          loadTerminalOutputCache(paneId)
            .then((cached) => {
              if (cancelled || !cached || cached.length === 0) return;
              terminal.write(cached);
              terminal.write("\r\n\x1b[90m--- session restored ---\x1b[0m");
              // Push restored content into scrollback so shell init
              // clear-screen sequences don't destroy it
              terminal.write("\r\n".repeat(terminal.rows));
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (!msg.startsWith("Cache not found:")) {
                console.warn(`[TerminalView] Unexpected error restoring cache for ${paneId}:`, err);
              }
            });
        }
      } else if (sessionCreated && width > 0 && height > 0) {
        fitAddon.fit();
      }
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelled = true;
      if (webglTimer !== undefined) clearTimeout(webglTimer);
      clearTimeout(notifyGateTimer);
      idleDetector.dispose();
      resizeObserver.disconnect();
      outerContainer?.removeEventListener("contextmenu", handleContextMenu);
      outerContainer?.removeEventListener("wheel", handleWheel);
      outerEl?.removeEventListener("keydown", handleKeyDown);
      outerEl?.removeEventListener("mousemove", handleMouseMove);
      if (paneId) {
        unregisterTerminalSerializer(paneId);
      }
      unlistenOutput?.();
      closeTerminalSession(instanceId).catch(() => {});
      terminal.dispose();
      unregisterInstance(instanceId);
    };
    // syncGroup intentionally excluded: changes (e.g. workspace rename) must NOT
    // destroy/recreate the terminal session. syncGroupRef is used at runtime instead.
    // paneId, lastCwd: mount-time only for session restore, must NOT trigger re-creation.
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

    const fontFamily = `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
    try {
      term.options.theme = scheme
        ? { ...defaultTheme, ...colorSchemeToXtermTheme(scheme as unknown as WTColorScheme) }
        : defaultTheme;
      term.options.fontSize = font.size;
      term.options.fontFamily = fontFamily;
    } catch {
      /* xterm mock may not support options setter */
    }
  }, [currentSchemeName, colorSchemes, font]);

  // Reactively update xterm overviewRuler width when scrollbarStyle changes
  const scrollbarStyleForEffect = useSettingsStore(
    (s) => s.convenience.scrollbarStyle ?? "overlay",
  );
  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.options) return;
    try {
      const newWidth = scrollbarStyleForEffect === "overlay" ? 0 : 14;
      term.options.overviewRuler = { width: newWidth };
      fitAddonRef.current?.fit();
    } catch {
      /* xterm mock may not support options setter */
    }
  }, [scrollbarStyleForEffect]);

  // Resolve terminal background for padding area
  const termBg = (() => {
    const scheme = currentSchemeName
      ? colorSchemes.find((cs) => cs.name === currentSchemeName)
      : undefined;
    return scheme?.background || "#1e1e2e";
  })();

  // Read padding from profile settings
  const padding = useSettingsStore((s) => s.profiles.find((p) => p.name === profile)?.padding);
  const pt = padding?.top ?? 8;
  const pr = padding?.right ?? 8;
  const pb = padding?.bottom ?? 8;
  const pl = padding?.left ?? 8;

  // Scrollbar style: overlay (default) renders on top of terminal content,
  // separate reserves space for the scrollbar.
  const scrollbarStyle = useSettingsStore((s) => s.convenience.scrollbarStyle ?? "overlay");
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
