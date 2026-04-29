import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createIndentedLinkProvider } from "@/lib/indented-link-provider";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore, type TerminalActivityInfo } from "@/stores/terminal-store";
import { useSettingsStore, defaultProfileDefaults } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { toSupportedCursorShape, toXtermCursorOptions } from "@/lib/cursor-settings";
import {
  createTerminalSession,
  writeToTerminal,
  resizeTerminal,
  closeTerminalSession,
  onTerminalOutput,
  smartPaste,
  clipboardWriteText,
  setTerminalCwdSend,
  setTerminalCwdReceive,
  updateTerminalSyncGroup,
  openExternal,
  markClaudeTerminal,
  markCodexTerminal,
} from "@/lib/tauri-api";
import { colorSchemeToXtermTheme, type WTColorScheme } from "@/lib/color-scheme";
import { transformPasteContent, prepareSelectionForCopy } from "@/lib/smart-text";
import { isLxShortcut } from "@/lib/lx-shortcuts";
import { createCursorTracer } from "@/lib/cursor-trace";
import { matchesKeybinding } from "@/lib/keybinding-registry";
import {
  createImeCompositionController,
  getCompositionPreviewLayout,
  resolveVisualCaretOwner,
  type CompositionPreviewState,
} from "@/lib/ime-composition-controller";
import { shouldDeferTerminalKeyToIme } from "@/lib/ime-key-policy";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  applyDec2026SetToShadowCursor,
  getShadowSyncEligibility,
  isOverlayCaretActivity,
  type ShadowCursorState,
} from "@/lib/shadow-cursor-state";

import {
  CODEX_INPUT_PENDING_MARKER,
  detectCodexConversationMessageFromOutput,
  detectCodexInputPendingFromOutput,
  detectCodexStatusMessageFromOutput,
  isCodexFooterStatusLine,
  detectActivityFromTitle,
  detectActivityFromCommand,
  detectActivityFromOutput,
} from "@/lib/activity-detection";
import { useNotificationStore } from "@/stores/notification-store";
import { resolveWorkspaceId } from "@/lib/workspace-utils";
import { OutputIdleDetector } from "@/lib/output-idle-detector";
import { SerializeAddon } from "@xterm/addon-serialize";
import { loadTerminalOutputCache } from "@/lib/tauri-api";
import {
  registerTerminalSerializer,
  unregisterTerminalSerializer,
} from "@/lib/terminal-serialize-registry";
import { usePaneControl } from "@/components/layout/PaneControlContext";

/** Default silence timeout for output idle detection (ms). */
const OUTPUT_IDLE_TIMEOUT_MS = 5000;

/** Byte-size threshold for the large paste warning dialog. */
const LARGE_PASTE_THRESHOLD = 5120;

const textEncoder = new TextEncoder();

function markBackendInteractiveTerminal(instanceId: string, activity: TerminalActivityInfo): void {
  if (activity.name === "Claude") {
    markClaudeTerminal(instanceId).catch(() => {});
  } else if (activity.name === "Codex") {
    markCodexTerminal(instanceId).catch(() => {});
  }
}

/**
 * Plain browser-clipboard paste. Shared by two spots in `runTerminalPaste`:
 * the smartPaste-off fast path and the Rust-clipboard error fallback.
 * `logPrefix` disambiguates the two in warnings.
 */
function pasteFromBrowserClipboard(terminal: Terminal, logPrefix: string): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) terminal.paste(text);
    })
    .catch((err) => {
      console.warn(`[TerminalView] ${logPrefix} failed:`, err);
    });
}

/**
 * Copy the current xterm selection to the system clipboard. Shared by the
 * terminal.copy keybinding, right-click copy, and copy-on-select so all three
 * paths produce byte-identical clipboard contents.
 *
 * When `smartRemoveIndent` is disabled the raw `getSelection()` string is
 * written verbatim. `prepareSelectionForCopy` always strips trailing
 * whitespace/blank lines, which would otherwise silently modify clipboard
 * contents for users who have opted out of the "smart" transforms.
 *
 * No-op when there is no selection so every call site can delegate the
 * has-selection check without repeating it.
 */
function runTerminalCopy(terminal: Terminal): void {
  if (!terminal.hasSelection()) return;
  const { convenience: conv } = useSettingsStore.getState();
  const text = conv.smartRemoveIndent
    ? prepareSelectionForCopy(terminal.getSelection(), { smartRemoveIndent: true })
    : terminal.getSelection();
  clipboardWriteText(text).catch((err) => {
    console.warn("[TerminalView] copy to clipboard failed:", err);
  });
}

/**
 * Execute the paste pipeline and write the result into xterm. Shared by the
 * keybinding handler (terminal.paste) and the right-click paste path so both
 * always behave identically.
 *
 * Honors the `smartPaste` convenience toggle internally: when the toggle is
 * disabled we skip image handling, indent/linebreak transforms, and the
 * large-paste guard, and fall back to a plain `navigator.clipboard.readText()`
 * → `terminal.paste()`. Keeping the toggle check here (rather than at each
 * call site) means an override binding like Ctrl+Shift+V still pastes — just
 * as plain text — instead of silently doing nothing.
 */
function runTerminalPaste(terminal: Terminal, profile: string): void {
  const { convenience: conv } = useSettingsStore.getState();
  if (!conv.smartPaste) {
    pasteFromBrowserClipboard(terminal, "plain paste");
    return;
  }
  smartPaste(conv.pasteImageDir, profile)
    .then((result) => {
      if (result.pasteType === "none" || !result.content) return;
      const content = transformPasteContent(result.content, result.pasteType, {
        removeIndent: conv.smartRemoveIndent,
        removeLineBreak: conv.smartRemoveLineBreak,
      });
      if (shouldBlockLargePaste(content, conv.largePasteWarning)) return;
      terminal.paste(content);
    })
    .catch((err) => {
      // Rust clipboard failed — fall back to browser clipboard → xterm paste
      console.warn("[TerminalView] smart paste failed, falling back to browser clipboard:", err);
      pasteFromBrowserClipboard(terminal, "fallback paste");
    });
}

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

function hasDecModeParam(params: readonly (number | number[])[], mode: number): boolean {
  return params.some((param) => (Array.isArray(param) ? param.includes(mode) : param === mode));
}

export function shouldEnableTerminalWebgl(): boolean {
  return true;
}

function getBufferCursorAbsY(terminal: Terminal): number {
  const activeBuffer = terminal.buffer.active as { baseY?: number; cursorY?: number };
  return (activeBuffer.baseY ?? 0) + (activeBuffer.cursorY ?? 0);
}

function getOverlayCaretMetrics(
  shape: "bar" | "underscore" | "filledBox",
  cellWidth: number,
  cellHeight: number,
): { width: number; height: number; offsetY: number } {
  switch (shape) {
    case "underscore": {
      const height = Math.max(2, Math.round(cellHeight * 0.12));
      return {
        width: Math.max(1, Math.round(cellWidth)),
        height,
        offsetY: Math.max(0, Math.round(cellHeight - height)),
      };
    }
    case "filledBox":
      return {
        width: Math.max(1, Math.round(cellWidth)),
        height: Math.max(1, Math.round(cellHeight)),
        offsetY: 0,
      };
    case "bar":
    default:
      return {
        width: Math.max(2, Math.round(cellWidth * 0.1)),
        height: Math.max(1, Math.round(cellHeight)),
        offsetY: 0,
      };
  }
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCaretRef = useRef<HTMLDivElement>(null);
  const compositionPreviewRefEl = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalReflowFrameRef = useRef<number | null>(null);
  const overlayCaretUpdaterRef = useRef<(() => void) | null>(null);
  const openedRef = useRef(false);
  // Each xterm rebuild gets a fresh generation, bumped at render time when
  // (instanceId, profile) changes. A monotonic counter is required because the
  // same (instanceId, profile) pair can be revisited (e.g. PS → WSL → PS quick
  // toggle) and a string key would let the second PS terminal inherit the first
  // one's ready state before its first paint.
  const terminalDepsKey = `${instanceId}:${profile}`;
  const lastTerminalDepsRef = useRef<string | null>(null);
  const terminalGenerationRef = useRef(0);
  if (lastTerminalDepsRef.current !== terminalDepsKey) {
    lastTerminalDepsRef.current = terminalDepsKey;
    terminalGenerationRef.current += 1;
  }
  const terminalGeneration = terminalGenerationRef.current;
  const [readyGeneration, setReadyGeneration] = useState(-1);
  const readyGenerationRef = useRef(-1);
  const isReady = readyGeneration === terminalGeneration;
  const isFocusedRef = useRef(isFocused);
  const activityRef = useRef<TerminalActivityInfo | undefined>(undefined);
  const stabilizeInteractiveCursorRef = useRef(true);
  const overlayCursorShapeRef = useRef<"bar" | "underscore" | "filledBox">("bar");
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

  // Issue #209: pinned 컨트롤 바 좌측에 쉘/TUI 가 설정한 title 을 주입한다.
  // 별도의 헤더 바를 만들지 않고 이미 존재하는 pinned 바의 빈 좌측 공간을 재활용한다.
  const paneCtx = usePaneControl();
  const setLeftBarContent = paneCtx?.setLeftBarContent;
  const controlBarMode = paneCtx?.mode;
  const rawTitle = useTerminalStore(
    (s) => s.instances.find((i) => i.id === instanceId)?.title?.trim() ?? "",
  );
  useEffect(() => {
    if (!setLeftBarContent) return;
    if (controlBarMode !== "pinned" || !rawTitle) {
      setLeftBarContent(null);
      return () => setLeftBarContent(null);
    }
    setLeftBarContent(
      <span
        data-testid={`terminal-pinned-info-title-${instanceId}`}
        className="min-w-0 flex-1 truncate text-[11px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        {rawTitle}
      </span>,
    );
    return () => setLeftBarContent(null);
  }, [setLeftBarContent, controlBarMode, instanceId, rawTitle]);
  const syncOutputActiveRef = useRef(false);
  const compositionPreviewRef = useRef<CompositionPreviewState>({
    active: false,
    text: "",
    caretUtf16Index: 0,
    caretCellOffset: 0,
    textCellWidth: 0,
    anchorBufferX: 0,
    anchorBufferAbsY: 0,
  });
  const shadowCursorRef = useRef<ShadowCursorState>({
    commandStartLine: 0,
    commandStartX: 0,
    cursorX: 0,
    cursorAbsY: 0,
    hasPromptBoundary: false,
    hasSyncFramePosition: false,
    isInputPhase: false,
    isRepaintInProgress: false,
    isAltBufferActive: false,
  });
  const shouldUseWebgl = shouldEnableTerminalWebgl();

  useEffect(() => {
    registerInstance({ id: instanceId, profile, syncGroup, workspaceId });

    // Diagnostic shadow-cursor tracer. Bound once per effect mount because
    // `instanceId` is constant inside this closure; the tracer is a no-op
    // unless `cursor-trace.ts` gating is on. See `cursor-trace.ts` for how
    // to enable.
    const trace = createCursorTracer(instanceId);

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

    const resolvedFont = settingsState.resolveFont(
      profile,
      paneId ? useOverridesStore.getState().getViewOverride(paneId) : undefined,
    );
    const resolvedCursorShape =
      profileConfig?.cursorShape ||
      settingsState.profileDefaults?.cursorShape ||
      defaultProfileDefaults.cursorShape;
    const resolvedCursorBlink =
      profileConfig?.cursorBlink ??
      settingsState.profileDefaults?.cursorBlink ??
      defaultProfileDefaults.cursorBlink;
    const cursorOptions = toXtermCursorOptions(resolvedCursorShape);
    const terminal = new Terminal({
      cursorBlink: resolvedCursorBlink,
      cursorStyle: cursorOptions.cursorStyle,
      ...(cursorOptions.cursorWidth ? { cursorWidth: cursorOptions.cursorWidth } : {}),
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

    // Additional link provider for hard-wrapped indented URLs (e.g. Claude Code OAuth).
    // Always registered; checks smartLinkJoin dynamically so setting changes apply immediately.
    terminal.registerLinkProvider(
      createIndentedLinkProvider(
        terminal,
        (uri) => openExternal(uri).catch(() => {}),
        () => useSettingsStore.getState().convenience.smartLinkJoin,
      ),
    );

    terminalRef.current = terminal;

    let prevHideNativeCursor: boolean | undefined;
    const applyNativeCursorVisibility = () => {
      const hideNativeCursor =
        compositionPreviewRef.current.active ||
        (stabilizeInteractiveCursorRef.current && isOverlayCaretActivity(activityRef.current));
      if (hideNativeCursor === prevHideNativeCursor) return;
      prevHideNativeCursor = hideNativeCursor;

      const state = useSettingsStore.getState();
      const liveProfile = state.profiles.find((p) => p.name === profile);
      const liveSchemeName =
        liveProfile?.colorScheme || state.profileDefaults?.colorScheme || "CampbellClear";
      const liveScheme = liveSchemeName
        ? state.colorSchemes.find((cs) => cs.name === liveSchemeName)
        : undefined;
      const resolvedTheme = liveScheme
        ? { ...defaultTheme, ...colorSchemeToXtermTheme(liveScheme as unknown as WTColorScheme) }
        : defaultTheme;
      const resolvedCursorShape =
        liveProfile?.cursorShape ||
        state.profileDefaults?.cursorShape ||
        defaultProfileDefaults.cursorShape;
      const resolvedCursorBlink =
        liveProfile?.cursorBlink ??
        state.profileDefaults?.cursorBlink ??
        defaultProfileDefaults.cursorBlink;
      const hiddenCursorColor = resolvedTheme.background ?? defaultTheme.background;

      if (hideNativeCursor) {
        terminal.options.theme = {
          ...resolvedTheme,
          cursor: hiddenCursorColor,
          cursorAccent: hiddenCursorColor,
        };
        terminal.options.cursorBlink = false;
        terminal.options.cursorStyle = "bar";
        terminal.options.cursorWidth = 1;
      } else {
        const cursorOptions = toXtermCursorOptions(resolvedCursorShape);
        terminal.options.theme = resolvedTheme;
        terminal.options.cursorBlink = resolvedCursorBlink;
        terminal.options.cursorStyle = cursorOptions.cursorStyle;
        if (cursorOptions.cursorWidth !== undefined) {
          terminal.options.cursorWidth = cursorOptions.cursorWidth;
        }
        if (cursorOptions.cursorWidth === undefined) {
          delete (terminal.options as { cursorWidth?: number }).cursorWidth;
        }
      }
      terminal.refresh(0, terminal.rows - 1);
    };

    const setSyncOutputCursorVisibility = (active: boolean) => {
      syncOutputActiveRef.current = active;
      const host = wrapperRef.current;
      if (host) {
        host.classList.toggle("terminal-sync-output-active", active);
      }
      trace("sync-output-visibility", { active });
      overlayCaretUpdaterRef.current?.();
    };
    const compositionController = createImeCompositionController({
      getAnchor: () => {
        // Use the shadow cursor, not the buffer cursor.  TUI apps (Claude Code,
        // Codex, etc.) move the buffer cursor to the footer/status-bar during
        // repaints, so reading it here would place the composition preview in
        // the wrong row.  The shadow cursor tracks the real input position.
        const shadow = shadowCursorRef.current;
        return {
          cursorX: shadow.cursorX,
          cursorAbsY: shadow.cursorAbsY,
        };
      },
      onTrace: (event, payload) => {
        trace(event, payload);
      },
      onStateChange: (state) => {
        const wasActive = compositionPreviewRef.current.active;
        compositionPreviewRef.current = state;
        wrapperRef.current?.classList.toggle("terminal-ime-composition-active", state.active);
        applyNativeCursorVisibility();
        trace("ime-composition-preview", state);
        if (wasActive && !state.active) {
          trace("ime-composition-preview-committed", {
            anchorBufferX: compositionPreviewRef.current.anchorBufferX,
            anchorBufferAbsY: compositionPreviewRef.current.anchorBufferAbsY,
          });
        }
        overlayCaretUpdaterRef.current?.();
        if (!state.active) {
          scheduleShadowCursorSync();
        }
      },
    });
    let overlayCaretFrame: number | undefined;
    let helperTextarea: HTMLTextAreaElement | null = null;
    const updateOverlayCaret = () => {
      const overlay = overlayCaretRef.current;
      const previewEl = compositionPreviewRefEl.current;
      const host = wrapperRef.current;
      const term = terminalRef.current;
      if (!overlay || !previewEl || !host || !term) return;

      const hideOverlay = () => {
        overlay.style.opacity = "0";
        previewEl.style.opacity = "0";
      };

      if (
        !openedRef.current ||
        !isFocusedRef.current ||
        !stabilizeInteractiveCursorRef.current ||
        !isOverlayCaretActivity(activityRef.current) ||
        syncOutputActiveRef.current
      ) {
        hideOverlay();
        trace("overlay-hidden", {
          reason: "gating",
          opened: openedRef.current,
          focused: isFocusedRef.current,
          stabilizeInteractiveCursor: stabilizeInteractiveCursorRef.current,
          activity: activityRef.current,
          syncOutputActive: syncOutputActiveRef.current,
        });
        return;
      }

      const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
      const canvas = term.element?.querySelector(
        ".xterm-screen canvas",
      ) as HTMLCanvasElement | null;
      const targetRect = canvas?.getBoundingClientRect() ?? screen?.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (!targetRect || term.cols <= 0 || term.rows <= 0) {
        hideOverlay();
        return;
      }

      const cellWidth = targetRect.width / term.cols;
      const cellHeight = targetRect.height / term.rows;
      if (
        !Number.isFinite(cellWidth) ||
        !Number.isFinite(cellHeight) ||
        cellWidth <= 0 ||
        cellHeight <= 0
      ) {
        hideOverlay();
        return;
      }

      const shadowCursor = shadowCursorRef.current;
      const caretOwner = resolveVisualCaretOwner({
        opened: openedRef.current,
        focused: isFocusedRef.current,
        stabilizeInteractiveCursor: stabilizeInteractiveCursorRef.current,
        overlayActivity: isOverlayCaretActivity(activityRef.current),
        syncOutputActive: syncOutputActiveRef.current,
        isAltBufferActive: shadowCursor.isAltBufferActive,
        compositionActive: compositionPreviewRef.current.active,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        isInputPhase: shadowCursor.isInputPhase,
      });
      if (caretOwner === "alt-buffer") {
        hideOverlay();
        trace("overlay-hidden", { reason: "alt-buffer", shadowCursor, caretOwner });
        return;
      }

      const baseY = (term.buffer.active as { baseY?: number }).baseY ?? 0;
      const useShadowCursor =
        caretOwner === "composition-preview" ||
        caretOwner === "sync-frame" ||
        caretOwner === "shadow-input";
      const compositionPreview = compositionPreviewRef.current;
      let cursorX = useShadowCursor
        ? shadowCursor.cursorX
        : ((term.buffer.active as { cursorX?: number }).cursorX ?? 0);
      let cursorY = useShadowCursor
        ? shadowCursor.cursorAbsY - baseY
        : ((term.buffer.active as { cursorY?: number }).cursorY ?? 0);
      if (caretOwner === "composition-preview") {
        const previewLayout = getCompositionPreviewLayout(compositionPreview, term.cols);
        cursorX = previewLayout.cursorX;
        cursorY = previewLayout.cursorAbsY - baseY;
        if (compositionPreview.text) {
          const anchorX = compositionPreview.anchorBufferX;
          const anchorY = compositionPreview.anchorBufferAbsY - baseY;
          previewEl.style.opacity = "1";
          previewEl.style.transform = `translate(${Math.round(targetRect.left - hostRect.left + anchorX * cellWidth)}px, ${Math.round(
            targetRect.top - hostRect.top + anchorY * cellHeight,
          )}px)`;
          previewEl.style.width = `${Math.max(cellWidth, previewLayout.maxRowCellWidth * cellWidth)}px`;
          previewEl.style.height = `${Math.max(1, previewLayout.rowCount * cellHeight)}px`;
          previewEl.style.fontSize = `${term.options.fontSize ?? Math.max(1, cellHeight)}px`;
          previewEl.style.lineHeight = `${Math.max(1, cellHeight)}px`;
          previewEl.textContent = previewLayout.renderedText;
        } else {
          previewEl.style.opacity = "0";
          previewEl.textContent = "";
        }
      } else {
        previewEl.style.opacity = "0";
        previewEl.textContent = "";
      }
      if (cursorY < 0 || cursorY >= term.rows) {
        hideOverlay();
        trace("overlay-hidden", {
          reason: "viewport",
          cursorX,
          cursorY,
          rows: term.rows,
          cols: term.cols,
          useShadowCursor,
        });
        return;
      }

      const caretMetrics = getOverlayCaretMetrics(
        overlayCursorShapeRef.current,
        cellWidth,
        cellHeight,
      );
      overlay.style.opacity = "1";
      overlay.style.width = `${caretMetrics.width}px`;
      overlay.style.height = `${caretMetrics.height}px`;
      overlay.style.transform = `translate(${Math.round(targetRect.left - hostRect.left + cursorX * cellWidth)}px, ${Math.round(
        targetRect.top - hostRect.top + cursorY * cellHeight + caretMetrics.offsetY,
      )}px)`;
      trace("overlay-update", {
        caretOwner,
        useShadowCursor,
        cursorX,
        cursorY,
        compositionAnchorX: compositionPreview.anchorBufferX,
        compositionAnchorAbsY: compositionPreview.anchorBufferAbsY,
        compositionCaretCellOffset: compositionPreview.caretCellOffset,
        cursorAbsY: shadowCursor.cursorAbsY,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        isInputPhase: shadowCursor.isInputPhase,
        isRepaintInProgress: shadowCursor.isRepaintInProgress,
        isAltBufferActive: shadowCursor.isAltBufferActive,
      });
    };
    const scheduleOverlayCaretUpdate = () => {
      if (overlayCaretFrame !== undefined) cancelAnimationFrame(overlayCaretFrame);
      overlayCaretFrame = requestAnimationFrame(() => {
        overlayCaretFrame = undefined;
        updateOverlayCaret();
      });
    };
    overlayCaretUpdaterRef.current = scheduleOverlayCaretUpdate;
    let pendingShadowCursorSync = false;
    const syncShadowCursorToBuffer = () => {
      const shadowCursor = shadowCursorRef.current;
      const activeBuffer = terminal.buffer.active as { cursorX?: number };
      shadowCursor.cursorX = activeBuffer.cursorX ?? 0;
      shadowCursor.cursorAbsY = getBufferCursorAbsY(terminal);
      trace("shadow-sync", {
        cursorX: shadowCursor.cursorX,
        cursorAbsY: shadowCursor.cursorAbsY,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        isInputPhase: shadowCursor.isInputPhase,
        isRepaintInProgress: shadowCursor.isRepaintInProgress,
        isAltBufferActive: shadowCursor.isAltBufferActive,
      });
    };
    const setInputPhase = (active: boolean) => {
      const shadowCursor = shadowCursorRef.current;
      shadowCursor.isInputPhase = active;
      if (!active) {
        shadowCursor.isRepaintInProgress = false;
      } else {
        syncShadowCursorToBuffer();
      }
      trace("input-phase", {
        active,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        cursorX: shadowCursor.cursorX,
        cursorAbsY: shadowCursor.cursorAbsY,
      });
      scheduleOverlayCaretUpdate();
    };
    // In TUI sync-frame mode, the buffer cursor mid-frame is whichever
    // footer/status row Codex last painted on; reading it via
    // `scheduleShadowCursorSync` would snap the overlay to the footer.
    // We use a row-equality gate: in `hasSyncFramePosition` mode, only
    // sync when the buffer cursor is on the same row as the current
    // shadow. This naturally tracks per-keystroke X advancement on the
    // input row (echo of typed glyph stays on the same row) but
    // ignores the cursor while Codex parks it on a footer row between
    // input restores. Composition is now handled by the dedicated
    // preview state/controller, so shadow sync is strictly for
    // committed-input and sync-frame ownership.
    const scheduleShadowCursorSync = () => {
      if (pendingShadowCursorSync) return;
      pendingShadowCursorSync = true;
      queueMicrotask(() => {
        pendingShadowCursorSync = false;
        const shadowCursor = shadowCursorRef.current;
        const bufferAbsY = getBufferCursorAbsY(terminal);
        const eligibility = getShadowSyncEligibility(shadowCursor, {
          bufferAbsY,
          compositionPreviewActive: compositionPreviewRef.current.active,
          syncOutputActive: syncOutputActiveRef.current,
        });
        if (eligibility !== "eligible") {
          trace("shadow-sync-skip", {
            reason: eligibility,
            bufferAbsY,
            shadowAbsY: shadowCursor.cursorAbsY,
          });
          return;
        }
        syncShadowCursorToBuffer();
        scheduleOverlayCaretUpdate();
      });
    };
    const handlePromptOsc = (data: string) => {
      const shadowCursor = shadowCursorRef.current;
      shadowCursor.hasPromptBoundary = true;
      trace("prompt-osc", {
        data,
        cursorX: shadowCursor.cursorX,
        cursorAbsY: shadowCursor.cursorAbsY,
      });
      switch (data.split(";")[0]) {
        case "A":
          setInputPhase(false);
          break;
        case "B":
          syncShadowCursorToBuffer();
          shadowCursor.commandStartX = shadowCursor.cursorX;
          shadowCursor.commandStartLine = shadowCursor.cursorAbsY;
          setInputPhase(true);
          break;
        case "C":
        case "D":
          setInputPhase(false);
          break;
        default:
          break;
      }
      return false;
    };
    let syncOutputMonitorFrame: number | undefined;
    const stopSyncOutputMonitor = () => {
      if (syncOutputMonitorFrame !== undefined) {
        cancelAnimationFrame(syncOutputMonitorFrame);
        syncOutputMonitorFrame = undefined;
      }
    };
    const monitorSyncOutputMode = () => {
      const active = Boolean(
        (terminal as Terminal & { modes?: { synchronizedOutputMode?: boolean } }).modes
          ?.synchronizedOutputMode,
      );
      setSyncOutputCursorVisibility(active);
      if (active && !cancelled) {
        syncOutputMonitorFrame = requestAnimationFrame(monitorSyncOutputMode);
      } else {
        syncOutputMonitorFrame = undefined;
      }
    };
    const startSyncOutputMonitor = () => {
      const active = Boolean(
        (terminal as Terminal & { modes?: { synchronizedOutputMode?: boolean } }).modes
          ?.synchronizedOutputMode,
      );
      if (!active) {
        setSyncOutputCursorVisibility(false);
        stopSyncOutputMonitor();
        return;
      }
      if (syncOutputMonitorFrame === undefined) {
        setSyncOutputCursorVisibility(true);
        syncOutputMonitorFrame = requestAnimationFrame(monitorSyncOutputMode);
      }
    };

    const parser = (
      terminal as Terminal & {
        parser?: {
          registerOscHandler?: (
            ident: number,
            callback: (data: string) => boolean | Promise<boolean>,
          ) => { dispose(): void };
          registerEscHandler?: (
            id: { final: string },
            callback: () => boolean | Promise<boolean>,
          ) => { dispose(): void };
          registerCsiHandler?: (
            id: { prefix?: string; final: string },
            callback: (params: readonly (number | number[])[]) => boolean | Promise<boolean>,
          ) => { dispose(): void };
        };
      }
    ).parser;

    const promptOsc133Disposable = parser?.registerOscHandler?.(133, handlePromptOsc);
    const promptOsc633Disposable = parser?.registerOscHandler?.(633, handlePromptOsc);
    const escSaveDisposable = parser?.registerEscHandler?.({ final: "7" }, () => {
      if (shadowCursorRef.current.isInputPhase) {
        shadowCursorRef.current.isRepaintInProgress = true;
      }
      return false;
    });
    const escRestoreDisposable = parser?.registerEscHandler?.({ final: "8" }, () => {
      if (shadowCursorRef.current.isRepaintInProgress) {
        shadowCursorRef.current.isRepaintInProgress = false;
        scheduleShadowCursorSync();
      }
      return false;
    });

    const syncOutputSetDisposable = parser?.registerCsiHandler?.(
      { prefix: "?", final: "h" },
      (params) => {
        if (hasDecModeParam(params, 2026)) {
          setSyncOutputCursorVisibility(true);
          if (isOverlayCaretActivity(activityRef.current)) {
            // Snapshot the buffer cursor *before* the frame body runs.
            // Codex's footer-update frames don't restore the cursor
            // before sending `\e[?2026l`, so reading the buffer at
            // reset time lands on the footer row. The pre-frame
            // snapshot is the cursor as the user actually sees it
            // (the input prompt position right before the frame
            // began). See `docs/terminal/cursor-jump-evidence/`.
            const activeBuffer = terminal.buffer.active as { cursorX?: number };
            Object.assign(
              shadowCursorRef.current,
              applyDec2026SetToShadowCursor(
                shadowCursorRef.current,
                activityRef.current,
                activeBuffer.cursorX ?? 0,
                getBufferCursorAbsY(terminal),
              ),
            );
          }
        }
        if (
          hasDecModeParam(params, 1049) ||
          hasDecModeParam(params, 1047) ||
          hasDecModeParam(params, 47)
        ) {
          shadowCursorRef.current.isAltBufferActive = true;
          shadowCursorRef.current.hasSyncFramePosition = false;
          shadowCursorRef.current.frameSavedCursorX = undefined;
          shadowCursorRef.current.frameSavedCursorAbsY = undefined;
          setInputPhase(false);
        }
        return false;
      },
    );
    const syncOutputResetDisposable = parser?.registerCsiHandler?.(
      { prefix: "?", final: "l" },
      (params) => {
        if (hasDecModeParam(params, 2026)) {
          setSyncOutputCursorVisibility(false);
          if (isOverlayCaretActivity(activityRef.current)) {
            // TUI DEC 2026 frame just flushed → snapshot the buffer
            // cursor as the authoritative shadow cursor. See
            // `shadow-cursor-state.ts` for why stale OSC 133 flags
            // from a prior shell session must be cleared here.
            const activeBuffer = terminal.buffer.active as { cursorX?: number };
            const bufferCursorAbsY = getBufferCursorAbsY(terminal);
            Object.assign(
              shadowCursorRef.current,
              applyDec2026ResetToShadowCursor(
                shadowCursorRef.current,
                activityRef.current,
                activeBuffer.cursorX ?? 0,
                bufferCursorAbsY,
              ),
            );
            scheduleOverlayCaretUpdate();
          } else {
            scheduleShadowCursorSync();
          }
        }
        if (
          hasDecModeParam(params, 1049) ||
          hasDecModeParam(params, 1047) ||
          hasDecModeParam(params, 47)
        ) {
          shadowCursorRef.current.isAltBufferActive = false;
          scheduleOverlayCaretUpdate();
        }
        return false;
      },
    );
    const cursorSaveDisposable = parser?.registerCsiHandler?.({ final: "s" }, () => {
      if (shadowCursorRef.current.isInputPhase) {
        shadowCursorRef.current.isRepaintInProgress = true;
      }
      return false;
    });
    const cursorRestoreDisposable = parser?.registerCsiHandler?.({ final: "u" }, () => {
      if (shadowCursorRef.current.isRepaintInProgress) {
        shadowCursorRef.current.isRepaintInProgress = false;
        scheduleShadowCursorSync();
      }
      return false;
    });
    const cursorMoveDisposable = terminal.onCursorMove(() => {
      if (compositionPreviewRef.current.active) return;
      const shadowCursor = shadowCursorRef.current;
      if (shadowCursor.isAltBufferActive || syncOutputActiveRef.current) return;
      const oscPath =
        shadowCursor.hasPromptBoundary &&
        shadowCursor.isInputPhase &&
        !shadowCursor.isRepaintInProgress;
      if (!oscPath && !shadowCursor.hasSyncFramePosition) return;
      scheduleShadowCursorSync();
    });
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      if (compositionPreviewRef.current.active) return;
      scheduleShadowCursorSync();
    });
    const renderDisposable = terminal.onRender(() => {
      if (readyGenerationRef.current !== terminalGeneration) {
        readyGenerationRef.current = terminalGeneration;
        setReadyGeneration(terminalGeneration);
      }
      scheduleOverlayCaretUpdate();
    });
    const bindHelperTextareaEvents = () => {
      const nextHelperTextarea = terminal.element?.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;
      if (!nextHelperTextarea || nextHelperTextarea === helperTextarea) return;
      helperTextarea = nextHelperTextarea;
      compositionController.bind(helperTextarea);
      scheduleOverlayCaretUpdate();
    };

    // view 인스턴스 폰트 줌 조정 (zoomIn/zoomOut 공용). paneId가 없으면 no-op.
    const adjustZoom = (delta: number) => {
      if (!paneId) return;
      const overrides = useOverridesStore.getState();
      const currentFont = useSettingsStore
        .getState()
        .resolveFont(profile, overrides.getViewOverride(paneId));
      const newSize = Math.max(6, Math.min(72, currentFont.size + delta));
      if (newSize !== currentFont.size) {
        overrides.setViewOverride(paneId, { fontSize: newSize });
      }
    };

    // Single entry point for all terminal key handling:
    //   - IDE-level shortcuts → pass through to document handler (return false).
    //   - terminal.copy / terminal.paste (default Ctrl+C / Ctrl+V, user-rebindable)
    //     → dispatch directly, no reliance on browser `copy`/`paste` events.
    //   - Ctrl+C with empty selection → fall through so xterm sends SIGINT.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (isLxShortcut(e)) return false;

      if (shouldDeferTerminalKeyToIme(compositionPreviewRef.current.active, e)) {
        return true;
      }

      if (matchesKeybinding(e, "terminal.paste")) {
        // runTerminalPaste honors the smartPaste toggle internally and falls
        // back to plain clipboard paste when it's off, so override bindings
        // like Ctrl+Shift+V still work regardless of the toggle.
        e.preventDefault();
        runTerminalPaste(terminal, profile);
        return false;
      }

      if (matchesKeybinding(e, "terminal.copy")) {
        // No selection: let xterm process the raw key (default Ctrl+C → SIGINT).
        if (!terminal.hasSelection()) return true;
        runTerminalCopy(terminal);
        e.preventDefault();
        return false;
      }

      // View 인스턴스 폰트 줌: overrides-store에만 기록, 프로파일은 건드리지 않음.
      if (matchesKeybinding(e, "terminal.zoomIn")) {
        adjustZoom(+1);
        e.preventDefault();
        return false;
      }
      if (matchesKeybinding(e, "terminal.zoomOut")) {
        adjustZoom(-1);
        e.preventDefault();
        return false;
      }
      if (matchesKeybinding(e, "terminal.zoomReset")) {
        if (paneId) useOverridesStore.getState().clearViewOverride(paneId);
        e.preventDefault();
        return false;
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

    // Copy-on-select: auto-copy to clipboard when text is selected.
    // `runTerminalCopy` handles the has-selection guard and smart-indent
    // branching, keeping this path in lockstep with Ctrl+C and right-click.
    terminal.onSelectionChange(() => {
      if (useSettingsStore.getState().convenience.copyOnSelect) {
        runTerminalCopy(terminal);
      }
    });

    // Issue #230: drag ending outside the terminal. xterm.js relies on
    // document-level mouseup to finalize a selection, but that signal can
    // be missed when the pointer leaves the viewport entirely (release
    // outside the browser window, or a neighbouring pane swallows the
    // event). We pair pointerdown on the terminal with a one-shot
    // pointerup listener on window so that every drag — wherever it
    // ends — gets a final chance to flush the selection to the clipboard.
    // `runTerminalCopy` still gates on `hasSelection()`, so click-without-
    // drag is a no-op.
    const handlePointerDown = () => {
      const onWindowPointerUp = () => {
        if (!useSettingsStore.getState().convenience.copyOnSelect) return;
        runTerminalCopy(terminal);
      };
      window.addEventListener("pointerup", onWindowPointerUp, { once: true });
    };
    outerEl?.addEventListener("pointerdown", handlePointerDown);

    // Handle terminal data (user input) — send to backend PTY
    terminal.onData((data) => {
      trace("terminal-onData", {
        bytes: data.length,
        preview: JSON.stringify(data.slice(0, 80)),
        compositionActive: compositionPreviewRef.current.active,
      });
      scheduleShadowCursorSync();
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
    let recentOutputTail = "";
    onTerminalOutput(instanceId, (data) => {
      if (cancelled) return;
      terminal.write(data, () => {
        startSyncOutputMonitor();
      });
      const text = streamDecoder.decode(data, { stream: true });
      const combinedText = (recentOutputTail + text).slice(-1024);
      recentOutputTail = combinedText;

      // OSC parsing and hook dispatch are now handled entirely in the Rust
      // PTY callback (iter_osc_events + match_hooks + dispatch_osc_action).
      // The frontend only needs to handle alt-screen detection and idle monitoring.

      // Feed idle detector on every output chunk
      const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
      if (inst?.activity?.type === "running") {
        idleDetector.recordOutput();
      }

      const outputActivity = detectActivityFromOutput(combinedText);
      if (outputActivity) {
        const current = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
        if (
          current?.activity?.type !== "interactiveApp" ||
          current.activity.name !== outputActivity.name
        ) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, { activity: outputActivity });
        }
      }

      const current = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
      if (current?.activity?.type === "interactiveApp" && current.activity.name === "Codex") {
        const codexConversationMessage = detectCodexConversationMessageFromOutput(combinedText);
        const codexStatusMessage = detectCodexStatusMessageFromOutput(combinedText);
        const currentMessage = current.activityMessage;
        const currentIsFooter =
          !!currentMessage &&
          currentMessage !== CODEX_INPUT_PENDING_MARKER &&
          isCodexFooterStatusLine(currentMessage);
        const nextCodexMessage =
          codexConversationMessage ??
          (currentIsFooter || !currentMessage ? codexStatusMessage : undefined);
        if (
          current.activityMessage === CODEX_INPUT_PENDING_MARKER &&
          text.trim() &&
          !detectCodexInputPendingFromOutput(text)
        ) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: nextCodexMessage,
          });
        } else if (detectCodexInputPendingFromOutput(combinedText)) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: CODEX_INPUT_PENDING_MARKER,
          });
        } else if (nextCodexMessage && current.activityMessage !== nextCodexMessage) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: nextCodexMessage,
          });
        }
      }

      // TODO(refactor): the OSC 133/633 needles below mirror the SIGNAL_CHECKS
      // table in `src-tauri/src/pty_trace.rs`. The A and C/D blocks also share
      // the same body shape (mark prompt boundary, log, exit input phase).
      // A future cleanup could collapse them into a small dispatch table —
      // out of scope for this PR (B has different command-state capture).
      if (text.includes("\x1b]133;A") || text.includes("\x1b]633;A")) {
        shadowCursorRef.current.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "A" });
        setInputPhase(false);
      }
      if (text.includes("\x1b]133;B") || text.includes("\x1b]633;B")) {
        const shadowCursor = shadowCursorRef.current;
        shadowCursor.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "B" });
        syncShadowCursorToBuffer();
        shadowCursor.commandStartX = shadowCursor.cursorX;
        shadowCursor.commandStartLine = shadowCursor.cursorAbsY;
        setInputPhase(true);
      }
      if (
        text.includes("\x1b]133;C") ||
        text.includes("\x1b]133;D") ||
        text.includes("\x1b]633;C") ||
        text.includes("\x1b]633;D")
      ) {
        shadowCursorRef.current.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "C/D" });
        setInputPhase(false);
      }

      // Detect alt screen buffer switch (vim, nano, htop, less, etc.)
      const enterAlt =
        text.includes("\x1b[?1049h") || text.includes("\x1b[?47h") || text.includes("\x1b[?1047h");
      const leaveAlt =
        text.includes("\x1b[?1049l") || text.includes("\x1b[?47l") || text.includes("\x1b[?1047l");
      if (enterAlt && !leaveAlt && !inAltScreen) {
        inAltScreen = true;
        shadowCursorRef.current.isAltBufferActive = true;
        trace("alt-buffer", { active: true });
        setInputPhase(false);
        // Parse OSC 133;E directly from the same output chunk (sync, no IPC race)
        const cmdMatch = text.match(/\x1b\]133;E;([^\x07]*)\x07/);
        const cmdActivity = cmdMatch ? detectActivityFromCommand(cmdMatch[1]) : undefined;
        if (cmdActivity) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, { activity: cmdActivity });
          markBackendInteractiveTerminal(instanceId, cmdActivity);
        } else {
          const inst = useTerminalStore.getState().instances.find((i) => i.id === instanceId);
          if (inst?.activity?.type === "interactiveApp" && inst.activity.name !== "app") {
            // Already identified — don't overwrite
          } else {
            const detected = detectActivityFromTitle(inst?.title ?? "");
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              activity: detected ?? { type: "interactiveApp", name: "app" },
            });
            if (detected) {
              markBackendInteractiveTerminal(instanceId, detected);
            }
          }
        }
      } else if (leaveAlt && !enterAlt && inAltScreen) {
        inAltScreen = false;
        shadowCursorRef.current.isAltBufferActive = false;
        trace("alt-buffer", { active: false });
        scheduleOverlayCaretUpdate();
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
        // Selection exists → copy via the shared helper, then clear.
        runTerminalCopy(terminal);
        terminal.clearSelection();
      } else {
        // No selection → paste via the shared smart-paste pipeline.
        runTerminalPaste(terminal, profile);
      }
    };
    outerContainer?.addEventListener("contextmenu", handleContextMenu);

    // Wait for container to have actual dimensions before opening terminal.
    // xterm.js viewport gets height 0 if opened in a zero-sized container,
    // causing rendering artifacts (garbled first row).
    let sessionCreated = false;
    // Tracks whether the previous ResizeObserver entry reported a zero-size
    // container. WorkspaceArea / PaneGrid hide inactive workspaces and panes
    // via `display: none`, which collapses the box and fires a 0×0 resize.
    // On the return trip to non-zero dimensions we must force the WebGL
    // texture atlas to rebuild — otherwise glyphs rasterised at the pre-hide
    // cell size / DPR stay cached and render completely garbled (issue #232).
    let prevWasHidden = false;
    // Last visible integer dimensions we acted on. ResizeObserver fires a
    // fresh entry every time `contentBoxSize` shifts by sub-pixel amounts
    // (DPR rounding, scrollbar layout, hover bars), so without this guard
    // we would call fit() — and through it `terminal.onResize` → PTY
    // resize round-trips — for changes the user never perceives.
    let prevW = 0;
    let prevH = 0;
    let webglTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const isNowHidden = width === 0 || height === 0;
      if (width > 0 && height > 0 && !sessionCreated) {
        sessionCreated = true;
        prevW = Math.round(width);
        prevH = Math.round(height);
        // Open terminal now that container has real dimensions
        if (containerRef.current) {
          terminal.open(containerRef.current);
        }
        bindHelperTextareaEvents();
        // WebGL renderer required for custom glyph drawing (box-drawing, block
        // elements). xterm.js v6 built-in renderer does not support customGlyphs.
        // Stagger creation to prevent simultaneous GPU context init crash.
        if (shouldUseWebgl) {
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
        }
        // Load SerializeAddon for session persistence
        const serializeAddon = new SerializeAddon();
        terminal.loadAddon(serializeAddon);

        // Register serializer for shutdown save
        if (paneId) {
          registerTerminalSerializer(paneId, () => serializeAddon.serialize());
        }
        registerTerminalSerializer(instanceId, () => serializeAddon.serialize());

        fitAddon.fit();
        openedRef.current = true;
        scheduleOverlayCaretUpdate();
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
            cwdSendRef.current,
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
        const recoveringFromHidden = prevWasHidden;
        const w = Math.round(width);
        const h = Math.round(height);
        // Skip identical-size callbacks unless we are returning from a
        // display:none hide (those still need an atlas rebuild even if
        // dimensions match the pre-hide values).
        if (!recoveringFromHidden && w === prevW && h === prevH) {
          prevWasHidden = isNowHidden;
          return;
        }
        prevW = w;
        prevH = h;
        fitAddon.fit();
        if (recoveringFromHidden) {
          // See `prevWasHidden` definition: the WebGL atlas can go stale
          // while the container is display:none (a DPR change that fires on
          // a 0-size terminal cannot rebuild anything), so re-rasterise on
          // the hide → show transition. Safe no-op without WebGL renderer.
          try {
            (terminal as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
          } catch {
            /* older xterm builds / mocks may lack this method */
          }
          terminal.refresh(0, terminal.rows - 1);
        }
        bindHelperTextareaEvents();
        scheduleOverlayCaretUpdate();
      }
      prevWasHidden = isNowHidden;
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelled = true;
      if (webglTimer !== undefined) clearTimeout(webglTimer);
      if (terminalReflowFrameRef.current !== null) {
        cancelAnimationFrame(terminalReflowFrameRef.current);
        terminalReflowFrameRef.current = null;
      }
      clearTimeout(notifyGateTimer);
      idleDetector.dispose();
      resizeObserver.disconnect();
      outerContainer?.removeEventListener("contextmenu", handleContextMenu);
      outerEl?.removeEventListener("keydown", handleKeyDown);
      outerEl?.removeEventListener("mousemove", handleMouseMove);
      outerEl?.removeEventListener("pointerdown", handlePointerDown);
      compositionController.dispose();
      wrapperRef.current?.classList.remove("terminal-ime-composition-active");
      if (overlayCaretFrame !== undefined) cancelAnimationFrame(overlayCaretFrame);
      overlayCaretUpdaterRef.current = null;
      stopSyncOutputMonitor();
      promptOsc133Disposable?.dispose();
      promptOsc633Disposable?.dispose();
      escSaveDisposable?.dispose();
      escRestoreDisposable?.dispose();
      syncOutputSetDisposable?.dispose();
      syncOutputResetDisposable?.dispose();
      cursorSaveDisposable?.dispose();
      cursorRestoreDisposable?.dispose();
      cursorMoveDisposable?.dispose();
      writeParsedDisposable?.dispose();
      renderDisposable?.dispose();
      setSyncOutputCursorVisibility(false);
      if (paneId) {
        unregisterTerminalSerializer(paneId);
      }
      unregisterTerminalSerializer(instanceId);
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

  // Update backend when cwdSend changes
  useEffect(() => {
    setTerminalCwdSend(instanceId, cwdSend).catch(() => {});
  }, [instanceId, cwdSend]);

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
      overlayCaretUpdaterRef.current?.();
    }
  }, [isFocused]);

  // Reactively update terminal theme when profile colorScheme or font changes
  const currentSchemeName = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return prof?.colorScheme || s.profileDefaults?.colorScheme || "CampbellClear";
  });
  const colorSchemes = useSettingsStore((s) => s.colorSchemes ?? []);
  // Split subscriptions so each returns a stable reference — composing inside
  // the selector (spreading a new object every call) would break Zustand's
  // strict-equality rerender gate and loop forever.
  const viewOverride = useOverridesStore((s) => (paneId ? s.viewOverrides[paneId] : undefined));
  const baseFont = useSettingsStore((s) => s.resolveFont(profile));
  const font = useMemo(() => {
    if (viewOverride?.fontSize !== undefined && viewOverride.fontSize !== baseFont.size) {
      return { ...baseFont, size: viewOverride.fontSize };
    }
    return baseFont;
  }, [baseFont, viewOverride]);
  const activity = useTerminalStore((s) => s.instances.find((i) => i.id === instanceId)?.activity);
  const prevActivityIsTuiRef = useRef<boolean>(false);
  {
    const isTui = isOverlayCaretActivity(activity);
    if (prevActivityIsTuiRef.current && !isTui) {
      // Leaving a TUI overlay activity (e.g. Codex exited) → clear the
      // per-frame sync-frame snapshot so OSC 133 from the returning
      // shell drives the overlay. See `shadow-cursor-state.ts`.
      Object.assign(
        shadowCursorRef.current,
        applyActivityLeftTuiToShadowCursor(shadowCursorRef.current),
      );
    }
    prevActivityIsTuiRef.current = isTui;
  }
  activityRef.current = activity;
  const cursorShape = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return (
      prof?.cursorShape || s.profileDefaults?.cursorShape || defaultProfileDefaults.cursorShape
    );
  });
  const cursorBlink = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return (
      prof?.cursorBlink ?? s.profileDefaults?.cursorBlink ?? defaultProfileDefaults.cursorBlink
    );
  });
  const overlayCursorShape = toSupportedCursorShape(cursorShape);
  overlayCursorShapeRef.current = overlayCursorShape;
  const stabilizeInteractiveCursor = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return (
      prof?.stabilizeInteractiveCursor ??
      s.profileDefaults?.stabilizeInteractiveCursor ??
      defaultProfileDefaults.stabilizeInteractiveCursor
    );
  });
  stabilizeInteractiveCursorRef.current = stabilizeInteractiveCursor;
  const effectiveCursorBlink = cursorBlink;
  const nativeCursorHidden = stabilizeInteractiveCursor && isOverlayCaretActivity(activity);
  const effectiveNativeCursorBlink = nativeCursorHidden ? false : effectiveCursorBlink;
  // Coalesce all reflow requests into a single rAF. Calling fit() +
  // clearTextureAtlas() + refresh() multiple times per tick (or even twice
  // back-to-back) compounds with TUI exit bursts (e.g. Codex's `ESC[?1049l`,
  // scrollback re-emit) and is what makes the WebGL atlas race manifest as
  // glyph corruption in adjacent panes.
  const runTerminalRendererReflow = (term: Terminal) => {
    if (terminalReflowFrameRef.current !== null) {
      cancelAnimationFrame(terminalReflowFrameRef.current);
    }
    terminalReflowFrameRef.current = requestAnimationFrame(() => {
      terminalReflowFrameRef.current = null;
      fitAddonRef.current?.fit();
      try {
        (term as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
      } catch {
        /* older xterm builds / mocks may lack this method */
      }
      term.refresh(0, term.rows - 1);
      overlayCaretUpdaterRef.current?.();
    });
  };
  useEffect(() => {
    overlayCaretUpdaterRef.current?.();
  }, [activity, isFocused, font, cursorShape, stabilizeInteractiveCursor]);
  // Option-only updates: theme, font (just the values), and cursor settings.
  // This effect must NOT call fit()/clearTextureAtlas()/refresh() directly —
  // cursor and theme changes do not move cell geometry, and triggering an
  // atlas rebuild on every activity transition (e.g. Codex start/exit) makes
  // the WebGL renderer race with TUI exit bursts. Cell-geometry reflow lives
  // in the dedicated effect below.
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
      cursorAccent: "#0C0C0C",
      selectionBackground: "#232042",
    };

    const fontFamily = `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
    try {
      const resolvedTheme = scheme
        ? { ...defaultTheme, ...colorSchemeToXtermTheme(scheme as unknown as WTColorScheme) }
        : defaultTheme;
      // WebGL renderer strips alpha from cursor color (rgba >> 8 & 0xFFFFFF),
      // so rgba(0,0,0,0) renders as opaque black. Hide the native cursor by
      // matching it to the background color instead.
      const hiddenCursorColor = resolvedTheme.background ?? defaultTheme.background;
      term.options.theme = nativeCursorHidden
        ? {
            ...resolvedTheme,
            cursor: hiddenCursorColor,
            cursorAccent: hiddenCursorColor,
          }
        : resolvedTheme;
      term.options.fontSize = font.size;
      term.options.fontFamily = fontFamily;
      if (nativeCursorHidden) {
        // Keep xterm's internal cursor renderer on its least disruptive path.
        // The visible caret is provided by the overlay, so block/invert rendering
        // only creates repaint artifacts on the active text cell.
        term.options.cursorBlink = false;
        term.options.cursorStyle = "bar";
        term.options.cursorWidth = 1;
      } else {
        const cursorOptions = toXtermCursorOptions(cursorShape);
        term.options.cursorBlink = effectiveNativeCursorBlink;
        term.options.cursorStyle = cursorOptions.cursorStyle;
        if (cursorOptions.cursorWidth !== undefined) {
          term.options.cursorWidth = cursorOptions.cursorWidth;
        }
        if (cursorOptions.cursorWidth === undefined) {
          delete (term.options as { cursorWidth?: number }).cursorWidth;
        }
      }
    } catch {
      /* xterm mock may not support options setter */
    }
  }, [
    currentSchemeName,
    colorSchemes,
    font,
    cursorShape,
    effectiveNativeCursorBlink,
    nativeCursorHidden,
    stabilizeInteractiveCursor,
  ]);

  // Cell-geometry reflow: only fontSize/fontFamily changes move xterm's
  // measured cell width/height, so the texture atlas only needs invalidation
  // on those transitions (issue #224). Cursor mode / activity changes must
  // not enter this path — they would trigger a fit + atlas rebuild during
  // TUI exit bursts and surface as glyph corruption (issue surfaced after
  // #224 fix).
  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.options) return;
    runTerminalRendererReflow(term);
  }, [font]);

  // Browser zoom / monitor DPR changes invalidate the WebGL texture atlas:
  // the renderer rasterises glyphs at a resolution tied to the current
  // devicePixelRatio, and a stale atlas after zoom leaves characters drawn
  // at the old pixel size, collapsing to the left side of each cell
  // (issue #224). `window.matchMedia` with a resolution query fires whenever
  // DPR changes, at which point we re-fit and force the atlas to rebuild.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mql: MediaQueryList | null = null;
    let cancelled = false;
    const onChange = () => {
      if (cancelled) return;
      const term = terminalRef.current;
      if (!term) return;
      try {
        runTerminalRendererReflow(term);
      } catch {
        /* addon/renderer may not be active yet */
      }
      // Re-subscribe to the NEW ratio so the listener keeps firing on
      // subsequent zoom steps. matchMedia with a fixed resolution only
      // fires once per crossing of its threshold.
      attach();
    };
    const attach = () => {
      const dpr = window.devicePixelRatio || 1;
      const query = `(resolution: ${dpr}dppx)`;
      mql?.removeEventListener?.("change", onChange);
      mql = window.matchMedia(query);
      mql.addEventListener?.("change", onChange);
    };
    attach();
    return () => {
      cancelled = true;
      mql?.removeEventListener?.("change", onChange);
    };
  }, []);

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

  const currentScheme = currentSchemeName
    ? colorSchemes.find((cs) => cs.name === currentSchemeName)
    : undefined;
  const overlayCaretColor = currentScheme?.cursorColor || "#FFFFFF";
  const termFg = currentScheme?.foreground || "#F0F0F0";
  const termBg = currentScheme?.background || "#1e1e2e";

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

  const wrapperStyle: CSSProperties & {
    "--terminal-overlay-caret-color": string;
    "--terminal-foreground-color": string;
    "--terminal-background-color": string;
  } = {
    "--terminal-overlay-caret-color": overlayCaretColor,
    "--terminal-foreground-color": termFg,
    "--terminal-background-color": termBg,
    background: termBg,
    padding: `${pt}px ${pr}px ${pb}px ${pl}px`,
  };

  return (
    <div
      ref={wrapperRef}
      data-testid={`terminal-view-${instanceId}`}
      className={`relative h-full w-full ${scrollbarClass} ${nativeCursorHidden ? "terminal-native-cursor-hidden" : ""}`}
      style={wrapperStyle}
    >
      <div ref={containerRef} className="h-full w-full" />
      <div
        ref={compositionPreviewRefEl}
        data-testid={`terminal-composition-preview-${instanceId}`}
        className="terminal-composition-preview pointer-events-none absolute"
        style={{
          background: termBg,
          opacity: 0,
          color: termFg,
          fontFamily: `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`,
        }}
      />
      <div
        ref={overlayCaretRef}
        data-testid={`terminal-overlay-caret-${instanceId}`}
        className="terminal-overlay-caret pointer-events-none absolute"
        style={{ opacity: 0 }}
      />
      <div
        data-testid={`terminal-loading-${instanceId}`}
        className={`terminal-loading-overlay ${isReady ? "" : "visible"}`}
        aria-hidden={isReady}
      >
        <div className="terminal-loading-spinner" />
      </div>
    </div>
  );
}
