import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createIndentedLinkProvider } from "@/lib/indented-link-provider";
import type { IndentedLineInfo } from "@/lib/indented-link-provider";
import { createPrLinkProvider } from "@/lib/pr-link-provider";
import { resolveLinkAtCell, isModifierLinkClick } from "@/lib/terminal-link-click";
import { createPathLinkController, type VerifiedPathSelection } from "@/lib/path-link-provider";
import {
  trimSelectionToPath,
  isWithinPathLengthLimit,
  joinCwdPath,
  decidePathLinkAction,
  mapSelectionToPathRange,
} from "@/lib/path-link-detect";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore, type TerminalActivityInfo } from "@/stores/terminal-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useSettingsStore, defaultProfileDefaults } from "@/stores/settings-store";
import { useOverridesStore, FONT_ZOOM_MIN, FONT_ZOOM_MAX } from "@/stores/overrides-store";
import { toSupportedCursorShape, toXtermCursorOptions } from "@/lib/cursor-settings";
import {
  createTerminalSession,
  type ViewerStartupRequest,
  writeToTerminal,
  writeTerminalProtocolReply,
  writeTerminalInput,
  resizeTerminal,
  closeTerminalSession,
  attachTerminalOutput,
  onTerminalOutputV2,
  smartPaste,
  clipboardWriteText,
  setTerminalCwdSend,
  setTerminalCwdReceive,
  updateTerminalSyncGroup,
  openExternal,
  resolveGitRemote,
  statPath,
  handleLxMessage,
  markClaudeTerminal,
  markCodexTerminal,
  getRemoteControlStatus,
  onRemoteControlChanged,
} from "@/lib/tauri-api";
import { colorSchemeToXtermTheme, type WTColorScheme } from "@/lib/color-scheme";
import { transformPasteContent, prepareSelectionForCopy, formatPastePaths } from "@/lib/smart-text";
import { isLxShortcut } from "@/lib/lx-shortcuts";
import { createCursorTracer } from "@/lib/cursor-trace";
import { matchesKeybinding } from "@/lib/keybinding-registry";
import {
  createImeCompositionController,
  getCompositionPreviewLayout,
  resolveVisualCaretOwner,
  type CompositionPreviewState,
} from "@/lib/ime-composition-controller";
import { activateTerminalUnicodeProvider } from "@/lib/terminal-unicode-width";
import { shouldBlockTerminalKeyDuringIme, shouldDeferTerminalKeyToIme } from "@/lib/ime-key-policy";
import { decideCommitRace } from "@/lib/composition-commit-race";
import { createHelperAnchorKeeper } from "@/lib/ime-anchor-keeper";
import {
  clampAnchorCell,
  computeCellMetrics,
  computeHelperAnchorStyle,
  shouldSyncHelperAnchor,
  type AnchorCell,
} from "@/lib/ime-anchor";
import { createLinuxImeCandidateGuard } from "@/lib/linux-ime-candidate-guard";
import { readCompositionStart, readPendingCompositionSend } from "@/lib/xterm-pending-composition";
import { createOsInputSourceChordGuard } from "@/lib/os-input-source-chord";
import {
  createTerminalFocusOwnership,
  type TerminalFocusOwnership,
} from "@/lib/terminal-focus-ownership";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  applyDec2026SetToShadowCursor,
  applyDectcemHideToShadowCursor,
  applyDectcemShowToShadowCursor,
  applyParkSettleTimeoutToShadowCursor,
  computeUseShadowCursor,
  getShadowSyncEligibility,
  isDectcemShowPark,
  isOverlayCaretActivity,
  shouldFreezeOverlayForPark,
  type ShadowCursorState,
} from "@/lib/shadow-cursor-state";

import {
  CODEX_INPUT_PENDING_MARKER,
  CLAUDE_INPUT_PENDING_MARKER,
  detectCodexConversationMessageFromOutput,
  detectCodexInputPendingFromOutput,
  detectNewCodexInputPendingPrompt,
  detectCodexStatusMessageFromOutput,
  detectNewClaudeInputPendingPrompt,
  detectClaudeRecapFromOutput,
  isCodexFooterStatusLine,
  detectActivityFromTitle,
  detectActivityFromCommand,
  detectActivityFromOutput,
  shouldDismissClaudeInputPendingFromOutput,
} from "@/lib/activity-detection";
import {
  detectClaudeSessionLimitFromOutput,
  computeSessionLimitResumeAt,
} from "@/lib/claude-session-limit";
import { useNotificationStore } from "@/stores/notification-store";
import { resolveWorkspaceId } from "@/lib/workspace-utils";
import { OutputIdleDetector } from "@/lib/output-idle-detector";
import { SerializeAddon } from "@xterm/addon-serialize";
import { loadTerminalOutputCache } from "@/lib/tauri-api";
import {
  registerTerminalSerializer,
  unregisterTerminalSerializer,
  registerTerminalInspector,
  registerTerminalScroller,
  unregisterTerminalInspector,
  unregisterTerminalScroller,
  type TerminalBufferLine,
} from "@/lib/terminal-serialize-registry";
import { normalBufferOnly, TERMINAL_OUTPUT_SERIALIZE_OPTIONS } from "@/lib/terminal-output-cache";
import { usePaneControl } from "@/components/layout/PaneControlContext";
import { ConptyResizeRepaintFilter } from "@/lib/conpty-resize-repaint-filter";
import {
  NativeWindowsOutputStabilizer,
  type StabilizedOutputEmission,
} from "@/lib/native-windows-output-stabilizer";
import {
  routeXtermData,
  subscribeXtermUserInputOrigin,
  type TerminalWriteSource,
} from "@/lib/terminal-data-route";
import {
  shouldStabilizeInitialExecutionHost,
  type InitialExecutionHost,
} from "@/lib/terminal-execution-host";
import { DeferredParsedCallbackQueue } from "@/lib/deferred-parsed-callback-queue";
import { TerminalInputComposer } from "@/components/ui/TerminalInputComposer";
import {
  beginComposerSubmission,
  composerHistoryScopeKey,
  DEFAULT_COMPOSER_HISTORY_SCOPE,
  pushComposerHistory,
  readComposerHistory,
  readRuntimeComposerDraft,
  isComposerKeyProxyActive,
  resolveComposerCompositionCommit,
  readRuntimeInputMode,
  settleComposerSubmission,
  subscribeRuntimeComposerDraft,
  updateComposerDraftText,
  writeDesktopInputModePreference,
  writeRuntimeComposerDraft,
  writeRuntimeInputMode,
  type ComposerDraftState,
  type InputMode,
} from "@/lib/terminal-input-composer-state";
import {
  encodeTerminalKey,
  isPassthroughControlChord,
  isPassthroughNavKey,
} from "@/lib/terminal-key-encoding";
import { matchesGlobalShortcut } from "@/hooks/useKeyboardShortcuts";
import {
  normalizeTerminalOutputAttachment,
  normalizeTerminalOutputDelta,
  TerminalOutputAttachCoordinator,
  type TerminalOutputDelta,
} from "@/lib/terminal-output-attach-coordinator";

/** Default silence timeout for output idle detection (ms). */
const OUTPUT_IDLE_TIMEOUT_MS = 5000;

/**
 * Trailing debounce (ms) before reflowing the terminal after a container-size
 * change. A pane-divider drag emits a ResizeObserver burst (one entry per
 * frame); reflowing on each intermediate width races xterm's synchronous
 * buffer reflow against ConPTY's async resize repaints and corrupts scrollback
 * (issue #285). Coalescing into a single fit after the drag settles removes the
 * interleaving. Kept short so a settled resize still feels immediate.
 */
const RESIZE_FIT_DEBOUNCE_MS = 80;

/** Windows-only silence after the last PTY chunk before xterm may reflow. */
const RESIZE_OUTPUT_QUIET_MS = 120;

/** Upper bound for waiting on a continuous ConPTY output stream before resize. */
const RESIZE_OUTPUT_MAX_WAIT_MS = 500;

/** ConPTY emits its resize repaint within this window after SIGWINCH. */
const CONPTY_RESIZE_REPAINT_WINDOW_MS = 500;

const REMOTE_CONTROL_STATUS_POLL_MS = 3000;
const REMOTE_RETURN_RESIZE_TIMEOUT_MS = 1000;
const REMOTE_RETURN_RESIZE_RETRY_MS = 100;

/** Keep retry chunks comfortably below xterm's 50 MB discard watermark. */
const TERMINAL_WRITE_CHUNK_SIZE = 1024 * 1024;
const TERMINAL_WRITE_RETRY_MS = 16;

/** Byte-size threshold for the large paste warning dialog. */
const LARGE_PASTE_THRESHOLD = 5120;

/** "separate" 스크롤바 모드에서 xterm overviewRuler가 예약하는 거터 폭(px). */
const SCROLLBAR_SEPARATE_GUTTER_PX = 14;

/**
 * jump-to-bottom 버튼의 우측 오프셋(px). 버튼은 pane 우측 끝 기준 절대위치이고,
 * xterm 스크롤바 슬라이더는 overlay/separate 모드 모두 우측 끝에 동일 폭으로
 * 렌더되므로(슬라이더 폭 ~14px), 모드와 무관하게 슬라이더를 비켜가는 단일 값을 쓴다.
 * 14px 슬라이더 + 12px 여유 = 26px (issue #361).
 */
const SCROLL_BTN_RIGHT_PX = SCROLLBAR_SEPARATE_GUTTER_PX + 12;

const textEncoder = new TextEncoder();

function markBackendInteractiveTerminal(instanceId: string, activity: TerminalActivityInfo): void {
  if (activity.name === "Claude") {
    markClaudeTerminal(instanceId).catch(() => {});
  } else if (activity.name === "Codex") {
    markCodexTerminal(instanceId).catch(() => {});
  }
}

function dismissTerminalResponseNotification(instanceId: string): void {
  const notifStore = useNotificationStore.getState();
  const dismissMode = useSettingsStore.getState().notifications.dismiss;
  if (dismissMode === "workspace") {
    const wsId = resolveWorkspaceId(instanceId);
    if (notifStore.getUnreadCount(wsId) > 0) notifStore.markWorkspaceAsRead(wsId);
  } else if (dismissMode === "paneFocus" && notifStore.hasUnreadForTerminal(instanceId)) {
    notifStore.markTerminalAsRead(instanceId);
  }
}

/**
 * Plain browser-clipboard paste. Shared by two spots in `runTerminalPaste`:
 * the smartPaste-off fast path and the Rust-clipboard error fallback.
 * `logPrefix` disambiguates the two in warnings.
 */
function pasteFromBrowserClipboard(writeText: (text: string) => void, logPrefix: string): void {
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) writeText(text);
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
 * When all smart-copy toggles are disabled the raw `getSelection()` string is
 * written verbatim. `prepareSelectionForCopy` always strips trailing
 * whitespace/blank lines, which would otherwise silently modify clipboard
 * contents for users who have opted out of the "smart" transforms.
 *
 * No-op when there is no selection so every call site can delegate the
 * has-selection check without repeating it.
 */
function runTerminalCopy(terminal: Terminal): void {
  if (!terminal.hasSelection()) return;
  const { paste } = useSettingsStore.getState();
  const useSmart = paste.removeIndent || paste.removeLineBreak;
  const text = useSmart
    ? prepareSelectionForCopy(terminal.getSelection(), {
        smartRemoveIndent: paste.removeIndent,
        smartRemoveLineBreak: paste.removeLineBreak,
      })
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
function runTerminalPaste(writeText: (text: string) => void, profile: string): void {
  const { paste } = useSettingsStore.getState();
  if (!paste.smart) {
    pasteFromBrowserClipboard(writeText, "plain paste");
    return;
  }
  smartPaste(paste.imageDir, profile)
    .then((result) => {
      if (result.pasteType === "none" || !result.content) return;
      // Multiple clipboard files (issue #325): join all resolved paths with
      // the configured separator, optionally quote-wrapping each path.
      // `paths` is absent for text pastes and older results — fall back to
      // the single `content` transform path.
      const content =
        result.pasteType === "path" && result.paths && result.paths.length > 0
          ? formatPastePaths(result.paths, {
              separator: paste.pathSeparator,
              quote: paste.pathQuote,
            })
          : transformPasteContent(result.content, result.pasteType, {
              removeIndent: paste.removeIndent,
              removeLineBreak: paste.removeLineBreak,
            });
      if (shouldBlockLargePaste(content, paste.largeWarning)) return;
      writeText(content);
    })
    .catch((err) => {
      // Rust clipboard failed — fall back to browser clipboard → xterm paste
      console.warn("[TerminalView] smart paste failed, falling back to browser clipboard:", err);
      pasteFromBrowserClipboard(writeText, "fallback paste");
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
    i18n.t("terminal.pasteConfirm", { ns: "common", bytes: byteLength.toLocaleString() }),
  );
}

/** Notify gate fallback timeout — only used for output idle detector gating. */
const NOTIFY_GATE_FALLBACK_MS = 3000;

// Stagger WebGL context creation to prevent WebView2 GPU process crash.
// Multiple near-simultaneous WebGL inits can trigger ACCESS_VIOLATION in msedge.dll.
// This is the next reserved start time, not an in-flight count: a later reveal
// wave must be placed after every already-reserved slot.
let webglNextInitAt = 0;
const WEBGL_STAGGER_MS = 150;

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Reserve the next globally-spaced WebGL initialization slot. */
export function _reserveWebglInitDelay(now = monotonicNow()): number {
  const scheduledAt = Math.max(now, webglNextInitAt);
  webglNextInitAt = scheduledAt + WEBGL_STAGGER_MS;
  return scheduledAt - now;
}

/** Reset the stagger timeline (for tests). */
export function _resetWebglStagger(): void {
  webglNextInitAt = 0;
}

/**
 * True on a Linux **desktop** host.
 *
 * Two exclusions matter. WSL runs a Windows WebView, so its user agent reports
 * Windows and must not enable Linux-only IME handling. Android WebView reports
 * `Linux; Android …` and is not a supported desktop target, so it is excluded
 * too rather than being silently treated as Linux.
 */
export function isLinuxHost(): boolean {
  const ua = navigator.userAgent;
  if (!ua.includes("Linux")) return false;
  return !ua.includes("Windows") && !ua.includes("Android");
}

/**
 * How long to hold overlay repaints after a DEC 2026 frame flush while
 * waiting for Codex's cursor park (`?25l` CUP `?25h` outside the frame).
 * The captured trace shows the park ~15 ms after the flush; 50 ms gives
 * slack for slow chunk delivery while staying well under the cursor
 * blink period (worst case the caret moves 50 ms late, never jumps).
 * See `docs/terminal/cursor-jump-evidence/`.
 */
const PARK_SETTLE_TIMEOUT_MS = 50;

/**
 * How many times the settle timeout may defer because a DEC 2026 frame
 * is still open before the frame is declared stale (its `?2026l` lost
 * to a chunk boundary or a stalled stream) and the fallback commits
 * anyway. 20 × 50 ms ≈ 1 s — the same self-heal horizon as xterm's own
 * synchronized-output safety timeout, which the parser-level frame
 * flag otherwise lacks.
 */
const PARK_SETTLE_MAX_DEFERRALS = 20;

function hasDecModeParam(params: readonly (number | number[])[], mode: number): boolean {
  return params.some((param) => (Array.isArray(param) ? param.includes(mode) : param === mode));
}

export function shouldEnableTerminalWebgl(): boolean {
  return true;
}

/**
 * 풀스크린 TUI(codex 등)가 마우스 트래킹을 켠 상태에서도 Shift/Alt+클릭으로
 * 링크를 열기 위한 좌표→셀 변환 + 링크 조회(issue #352).
 *
 * xterm 의 마우스 좌표 변환(`_mouseService.getCoords`)과 OSC 8 hyperlink
 * 조회(`_oscLinkService.getLinkData`)는 공개 API 가 아니라 코어 내부에 있다.
 * 모든 접근을 try/catch + optional 로 감싸 빌드/버전 변동에 안전하게 한다.
 * (평문 URL / 들여쓰기 하드랩 URL 은 공개 buffer API 만으로도 동작한다.)
 */
interface XtermCoreLite {
  _mouseService?: {
    getCoords?: (
      event: MouseEvent,
      element: HTMLElement | null,
      cols: number,
      rows: number,
    ) => [number, number] | undefined;
  };
  _oscLinkService?: {
    getLinkData?: (linkId: number) => { uri?: string } | undefined;
  };
  screenElement?: HTMLElement | null;
}

/** 클릭 좌표를 1-based [컬럼, 뷰포트 행] 으로 변환. 실패 시 undefined. */
function getClickCellCoords(terminal: Terminal, event: MouseEvent): [number, number] | undefined {
  try {
    const core = (terminal as Terminal & { _core?: XtermCoreLite })._core;
    const mouseService = core?._mouseService;
    if (!mouseService?.getCoords) return undefined;
    const element = core?.screenElement ?? terminal.element ?? null;
    return mouseService.getCoords(event, element, terminal.cols, terminal.rows);
  } catch {
    return undefined;
  }
}

/**
 * 해당 0-based 버퍼 셀의 OSC 8 hyperlink uri 를 조회한다(없으면 undefined).
 * 셀의 확장 속성(`extended.urlId`)과 코어의 OSC 링크 서비스를 사용하는데
 * 둘 다 내부 API 이므로 방어적으로 접근한다.
 */
function getOscLinkUriAtCell(
  terminal: Terminal,
  bufferLine0: number,
  col0: number,
): string | undefined {
  try {
    const line = terminal.buffer.active.getLine(bufferLine0);
    if (!line) return undefined;
    const cell = line.getCell(col0) as
      | {
          getChars?: () => string;
          hasExtendedAttrs?: () => number;
          extended?: { urlId?: number };
        }
      | undefined;
    const urlId = cell?.extended?.urlId;
    if (!urlId) return undefined;
    const core = (terminal as Terminal & { _core?: XtermCoreLite })._core;
    const uri = core?._oscLinkService?.getLinkData?.(urlId)?.uri;
    return uri || undefined;
  } catch {
    return undefined;
  }
}

function getBufferCursorAbsY(terminal: Terminal): number {
  const activeBuffer = terminal.buffer.active as { baseY?: number; cursorY?: number };
  return (activeBuffer.baseY ?? 0) + (activeBuffer.cursorY ?? 0);
}

/**
 * Whether the viewport is scrolled away from the bottom of the scrollback
 * (issue #349). xterm exposes the bottom-most scroll offset as
 * `buffer.active.baseY` and the current top-of-viewport line as
 * `viewportY`; they are equal exactly when the user is pinned to the live
 * bottom. Treated as "at bottom" whenever they match (or the API is
 * unavailable) so the floating jump-to-bottom button only appears while the
 * user is actually looking at scrollback.
 */
export function isTerminalScrolledUp(terminal: Terminal): boolean {
  const activeBuffer = terminal.buffer.active as { baseY?: number; viewportY?: number };
  const baseY = activeBuffer.baseY ?? 0;
  const viewportY = activeBuffer.viewportY ?? baseY;
  return viewportY < baseY;
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
  /** Structured external viewer command. Rust validates and quotes the path. */
  viewerStartup?: ViewerStartupRequest;
}

interface TerminalFitRequest {
  rebuildAtlas?: boolean;
  syncBackendResize?: boolean;
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
  viewerStartup,
}: TerminalViewProps) {
  const { t } = useTranslation("common");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCaretRef = useRef<HTMLDivElement>(null);
  const compositionPreviewRefEl = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalReflowFrameRef = useRef<number | null>(null);
  const pendingRendererFitRequestRef = useRef<TerminalFitRequest | null>(null);
  const guardedTerminalFitRef = useRef<((request: TerminalFitRequest) => void) | null>(null);
  // Tracks whether the TerminalView's container is currently hidden
  // (display:none → 0×0). WorkspaceArea hides inactive workspaces this way
  // and the font/DPR/scrollbar reflow effects (defined below) consult this
  // ref so they can defer fit()/atlas rebuild instead of running on a 0×0
  // container — which would propagate cols/rows=0 through a PTY resize and
  // leave inactive workspaces with garbled glyphs on next show.
  const isContainerHiddenRef = useRef(false);
  const remoteControlActiveRef = useRef(false);
  // Until the initial lease status is known, do not let this local surface
  // write or resize the shared PTY. A remote controller may already own it.
  const remoteControlStatusKnownRef = useRef(false);
  const [localControlAvailable, setLocalControlAvailable] = useState(false);
  const localControlAvailableRef = useRef(false);
  const [outputProtocolReady, setOutputProtocolReady] = useState(false);
  const outputProtocolReadyRef = useRef(false);
  const [inputMode, setInputMode] = useState<InputMode>(() => readRuntimeInputMode(instanceId));
  const inputModeRef = useRef(inputMode);
  const lastComposerLayoutModeRef = useRef(inputMode);
  const [composerDraft, setComposerDraft] = useState<ComposerDraftState>(() =>
    readRuntimeComposerDraft(instanceId),
  );
  const composerDraftRef = useRef(composerDraft);
  // OSC 133 input phase mirrored into state: true at a shell prompt (↑/↓ recall
  // Composer history), false while a program runs (↑/↓ pass through to it).
  const [atShellPrompt, setAtShellPrompt] = useState(true);
  const atShellPromptRef = useRef(true);
  // Composer sent-history cursor (null = editing the live draft) + the draft
  // stashed when history navigation began.
  const historyNavRef = useRef<{ index: number | null; stash: string }>({
    index: null,
    stash: "",
  });
  const currentInstanceIdRef = useRef(instanceId);
  currentInstanceIdRef.current = instanceId;

  const storeComposerDraft = (next: ComposerDraftState, terminalId = instanceId) => {
    const stored = writeRuntimeComposerDraft(terminalId, next);
    // The subscription normally updates the active mount synchronously. Keep
    // this fallback for the tiny pre-effect window before it is installed.
    if (currentInstanceIdRef.current === terminalId && composerDraftRef.current !== stored) {
      composerDraftRef.current = next;
      setComposerDraft(next);
    }
  };

  const changeInputMode = (next: InputMode) => {
    inputModeRef.current = writeRuntimeInputMode(instanceId, next);
    setInputMode(next);
    writeDesktopInputModePreference(next);
  };

  /**
   * The one place a Composer history bucket key is derived on this surface
   * (ADR-0055). Reads the scope non-reactively because write-path callers run
   * outside render; the rendered list uses the reactive selector below and both
   * end up in `composerHistoryScopeKey`.
   */
  const resolveComposerHistoryKey = (terminalId = instanceId) => {
    const scope =
      useSettingsStore.getState().terminal.composerHistoryScope ?? DEFAULT_COMPOSER_HISTORY_SCOPE;
    return composerHistoryScopeKey(scope, {
      terminalId,
      workspaceId: scope === "workspace" ? resolveWorkspaceId(terminalId) : undefined,
    });
  };

  const submitComposerDraft = () => {
    if (!localControlAvailableRef.current || !outputProtocolReadyRef.current) return;
    const started = beginComposerSubmission(composerDraftRef.current, {
      terminalId: instanceId,
    });
    if (!started) return;
    storeComposerDraft(started.draft);
    historyNavRef.current = { index: null, stash: "" };
    dismissTerminalResponseNotification(instanceId);
    writeTerminalInput(instanceId, started.submission.text, true)
      .then(() => {
        pushComposerHistory(
          resolveComposerHistoryKey(started.submission.terminalId),
          started.submission.text,
        );
        storeComposerDraft(
          settleComposerSubmission(readRuntimeComposerDraft(started.submission.terminalId), {
            token: started.submission.token,
            outcome: "success",
          }),
          started.submission.terminalId,
        );
      })
      .catch((error) => {
        console.warn("[TerminalView] composer input failed:", error);
        storeComposerDraft(
          settleComposerSubmission(readRuntimeComposerDraft(started.submission.terminalId), {
            token: started.submission.token,
            outcome: "ambiguous",
          }),
          started.submission.terminalId,
        );
      });
  };

  const writePastedText = (text: string) => {
    if (!localControlAvailableRef.current || !outputProtocolReadyRef.current || !text) return;
    dismissTerminalResponseNotification(instanceId);
    writeTerminalInput(instanceId, text, false).catch((error) => {
      console.warn("[TerminalView] terminal paste failed:", error);
    });
  };
  const writeStructuredPaste = (text: string) => {
    if (inputModeRef.current !== "direct") return;
    writePastedText(text);
  };
  /**
   * Composer paste while this pane proxies the keyboard (issue #560). Same write path
   * as Direct mode's native paste, so a pasted prompt reaches a fullscreen app
   * identically in both input modes.
   */
  const writeProxyPaste = (text: string) => {
    if (inputModeRef.current !== "composer") return;
    writePastedText(text);
  };
  const localTerminalControlAllowed = () =>
    remoteControlStatusKnownRef.current && !remoteControlActiveRef.current;

  /**
   * Whether the keyboard currently belongs to the terminal rather than the draft
   * (`isComposerKeyProxyActive`). The composer asks this for the gestures that reach
   * the draft without passing through `passthroughComposerKey` — the Shift+Enter
   * newline, the Tab recall popup, paste.
   */
  const composerKeyProxyActive = (ctx: { empty: boolean }): boolean => {
    if (!localTerminalControlAllowed()) return false;
    const term = terminalRef.current;
    if (!term) return false;
    return isComposerKeyProxyActive({
      altScreen: term.buffer?.active?.type === "alternate",
      draftEmpty: ctx.empty,
    });
  };

  const pasteComposerProxy = (text: string) => {
    if (!composerKeyProxyActive({ empty: composerDraftRef.current.text.length === 0 })) return;
    writeProxyPaste(text);
  };

  /**
   * Route a finished composition to the PTY when this pane is proxying keys for a
   * fullscreen app (issue #558). Keys cannot carry a composition, so the committed
   * text is forwarded instead — through the same write path ASCII passthrough uses, so
   * Korean reaches the app exactly the way typed characters already do.
   */
  const commitComposerComposition = (data: string) => {
    if (!localTerminalControlAllowed()) return;
    const term = terminalRef.current;
    if (!term) return;
    const decision = resolveComposerCompositionCommit({
      altScreen: term.buffer?.active?.type === "alternate",
      data,
      draft: composerDraftRef.current.text,
    });
    if (!decision) return;
    // Empty the draft first: the decision only routes when the composition *was* the
    // whole draft, and if the write rejects an untouched draft would still be
    // unreachable (every key passes through), which is the orphan being fixed.
    storeComposerDraft(updateComposerDraftText(composerDraftRef.current, ""));
    dismissTerminalResponseNotification(instanceId);
    writeToTerminal(instanceId, decision.pty).catch((error) => {
      console.warn("[TerminalView] composer composition passthrough failed:", error);
    });
  };
  /**
   * Forward a Composer keystroke to the PTY instead of the draft. An empty draft lends
   * the keyboard out (`isComposerKeyProxyActive`): to a fullscreen app it lends *every*
   * key, like Direct mode, and at the shell only non-text nav keys and activity-control
   * chords, so shell history and Ctrl+C keep working. A non-empty draft keeps the
   * keyboard so the text on screen can always be submitted or erased (issue #560).
   * Encoding defers to xterm's reported cursor-key mode.
   */
  const passthroughComposerKey = (event: KeyboardEvent, ctx: { empty: boolean }): boolean => {
    if (!localTerminalControlAllowed()) return false;
    // laymux controls consume first (rebind-aware): any combo bound to a
    // document-level action (pane focus = Alt+Arrow by default, workspace nav =
    // Ctrl+Alt+…, or whatever the user rebound them to) is never forwarded — it
    // bubbles to the document shortcut handler. No hardcoded modifier rules.
    if (matchesGlobalShortcut(event)) return false;
    const term = terminalRef.current;
    if (!term) return false;
    const proxy = isComposerKeyProxyActive({
      altScreen: term.buffer?.active?.type === "alternate",
      draftEmpty: ctx.empty,
    });
    // Empty draft forwards nav keys (menus, shell history) and activity-control
    // chords (Ctrl+C/D/Z/L) so a running command stays interruptible.
    const emptyPassthrough =
      ctx.empty && (isPassthroughNavKey(event) || isPassthroughControlChord(event));
    if (!proxy && !emptyPassthrough) return false;
    const applicationCursor = Boolean(
      (term as unknown as { modes?: { applicationCursorKeysMode?: boolean } }).modes
        ?.applicationCursorKeysMode,
    );
    const seq = encodeTerminalKey(event, { applicationCursor });
    if (seq == null) return false;
    dismissTerminalResponseNotification(instanceId);
    writeToTerminal(instanceId, seq).catch((error) => {
      console.warn("[TerminalView] composer key passthrough failed:", error);
    });
    return true;
  };

  /**
   * Recall the Composer's own sent-history into the draft (shell prompt only, via
   * ↑/↓ at the draft edges). Keeping it in the editor — rather than passing ↑ to
   * the shell — avoids the recalled command landing on the terminal line detached
   * from the editor. Always returns true so the caller consumes the key.
   */
  const navigateComposerHistory = (direction: "prev" | "next"): boolean => {
    const history = readComposerHistory(resolveComposerHistoryKey());
    const nav = historyNavRef.current;
    if (direction === "prev") {
      if (history.length === 0) return true;
      if (nav.index === null) {
        nav.stash = composerDraftRef.current.text;
        nav.index = history.length;
      }
      if (nav.index === 0) return true; // already at the oldest entry
      nav.index -= 1;
      storeComposerDraft(updateComposerDraftText(composerDraftRef.current, history[nav.index]));
      return true;
    }
    if (nav.index === null) return true; // not navigating — nothing newer to show
    nav.index += 1;
    const recalled = nav.index >= history.length ? nav.stash : history[nav.index];
    if (nav.index >= history.length) nav.index = null;
    storeComposerDraft(updateComposerDraftText(composerDraftRef.current, recalled));
    return true;
  };

  useEffect(() => {
    const nextMode = readRuntimeInputMode(instanceId);
    const nextDraft = readRuntimeComposerDraft(instanceId);
    inputModeRef.current = nextMode;
    historyNavRef.current = { index: null, stash: "" };
    composerDraftRef.current = nextDraft;
    outputProtocolReadyRef.current = false;
    setInputMode(nextMode);
    setComposerDraft(nextDraft);
    setOutputProtocolReady(false);
    return subscribeRuntimeComposerDraft(instanceId, (draft) => {
      if (currentInstanceIdRef.current !== instanceId) return;
      composerDraftRef.current = draft;
      setComposerDraft(draft);
    });
  }, [instanceId]);
  // Marks that a reflow trigger fired while the container was hidden. The
  // ResizeObserver's hidden→visible branch consumes this in addition to
  // `prevWasHidden` so the deferred fit() + atlas rebuild fires exactly
  // once when the workspace becomes visible again.
  const reflowDirtyRef = useRef(false);
  const remoteReturnResizeDirtyRef = useRef(false);
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
  // Issue #349: floating "jump to bottom" button. Shown while the user has
  // scrolled up into the scrollback; hidden once pinned to the live bottom.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
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
  // 리뷰 C: path-link provider 의 getCwd 가 hover(줄)마다 instances.find 로
  // store 배열을 전수 스캔하지 않도록, 이 pane 의 cwd 를 selector 로 한 번
  // 구독해 ref 로 유지한다(syncGroupRef 와 동일 패턴).
  const cwd = useTerminalStore((s) => s.instances.find((i) => i.id === instanceId)?.cwd);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Issue #439: pane 의 GitHub 베이스 URL(https://github.com/{owner}/{repo}).
  // cwd 변경 시 백엔드(resolve_git_remote)로 비동기 해석해 ref 에 저장한다.
  // pr-link-provider 는 provideLinks 안에서 이 ref 를 **동기로만** 읽는다
  // (invoke 는 async 이므로 provider 안에서 호출 금지).
  const repoBaseRef = useRef<string | null>(null);
  // Issue #530: 앱 blur 시 실제 DOM focus 를 갖고 있던 helper textarea 의
  // identity 를 기억해, 앱 복귀 다음 프레임에 focus 가 여전히 body/null 일 때만
  // 같은 helper 로 복원한다. 메인 effect 가 생성하고 isFocused effect 도 참조한다.
  const focusOwnershipRef = useRef<TerminalFocusOwnership | null>(null);
  // Issue #363: 선택 기반 path-link 컨트롤러와 검증 흐름. effect 안에서 채우고
  // selection/pointerup 핸들러에서 호출한다(메인 effect 1회 생성).
  const pathLinkControllerRef = useRef<ReturnType<typeof createPathLinkController> | null>(null);
  const pathLinkEvaluateRef = useRef<(() => void) | null>(null);
  const registerInstance = useTerminalStore((s) => s.registerInstance);
  const unregisterInstance = useTerminalStore((s) => s.unregisterInstance);

  // Issue #209: pinned 컨트롤 바 좌측에 쉘/TUI 가 설정한 title 을 주입한다.
  // 별도의 헤더 바를 만들지 않고 이미 존재하는 pinned 바의 빈 좌측 공간을 재활용한다.
  const paneCtx = usePaneControl();
  const setLeftBarContent = paneCtx?.setLeftBarContent;
  const setInputModeToggle = paneCtx?.setInputModeToggle;
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
        className="ui-toolbar-title min-w-0 flex-1 truncate text-[11px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        {rawTitle}
      </span>,
    );
    return () => setLeftBarContent(null);
  }, [setLeftBarContent, controlBarMode, instanceId, rawTitle]);
  // Publish the terminal's input-mode toggle into the pane control bar so mode
  // switching lives as a single toolbar button (not a bottom bar). onToggle reads
  // the live mode via ref, so the handler stays correct without re-subscribing.
  useEffect(() => {
    if (!setInputModeToggle) return;
    setInputModeToggle({
      mode: inputMode,
      onToggle: () => changeInputMode(inputModeRef.current === "direct" ? "composer" : "direct"),
    });
    return () => setInputModeToggle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setInputModeToggle, inputMode]);
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
    isCursorHidden: false,
    parkPending: false,
    isDec2026FrameOpen: false,
    hasPromptBoundary: false,
    hasSyncFramePosition: false,
    isInputPhase: false,
    isRepaintInProgress: false,
    isAltBufferActive: false,
  });
  const shouldUseWebgl = shouldEnableTerminalWebgl();

  useEffect(() => {
    let cancelled = false;
    let terminalSessionReady = false;
    let initialExecutionHost: InitialExecutionHost = "unknown";
    let stabilizeNativeWindowsOutput = false;
    let currentParsingWriteSource: TerminalWriteSource | undefined;
    let currentParsingParkDeadline: number | undefined;
    let currentParsingAttachEpoch: number | undefined;
    let humanDataEmissionDepth = 0;
    let pendingXtermUserInputOrigins = 0;
    let firstRenderReady = false;
    let startupSettled = false;
    const settleStartupIfReady = () => {
      if (cancelled || startupSettled || !paneId || !terminalSessionReady || !firstRenderReady) {
        return;
      }
      startupSettled = true;
      useTerminalStartupStore.getState().settleStartup(paneId);
    };
    const settleFailedStartup = () => {
      if (cancelled || startupSettled || !paneId) return;
      startupSettled = true;
      useTerminalStartupStore.getState().settleStartup(paneId);
    };

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
    const sbStyle = settingsState.terminal.scrollbarStyle ?? "overlay";
    const overviewRulerWidth = sbStyle === "overlay" ? 0 : SCROLLBAR_SEPARATE_GUTTER_PX;

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
      // #363: 선택한 경로 밑줄을 IDecoration(registerDecoration)으로 그린다.
      // 데코레이션은 xterm 의 proposed API 라 이 옵션이 없으면 throw 한다.
      allowProposedApi: true,
      // xterm's CoreService still emits parser-generated replies when stdin is
      // disabled, but blocks keyboard/IME/mouse/focus user input. Start closed
      // until the remote-control owner snapshot is known.
      disableStdin: true,
      cursorBlink: resolvedCursorBlink,
      cursorStyle: cursorOptions.cursorStyle,
      cursorInactiveStyle: inputModeRef.current === "composer" ? "none" : "outline",
      ...(cursorOptions.cursorWidth ? { cursorWidth: cursorOptions.cursorWidth } : {}),
      fontSize: resolvedFont.size,
      fontFamily: `'${resolvedFont.face}', 'Cascadia Mono', 'Consolas', monospace`,
      theme,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      overviewRuler: { width: overviewRulerWidth },
      scrollback: 10000,
      // ConPTY backend with buildNumber >= 21376 enables xterm's own buffer
      // reflow so scrollback re-wraps correctly on a width change. ConPTY also
      // repaints its old screen after a resize; the guarded output path below
      // removes that one frame before it can overwrite reflowed scrollback.
      windowsPty: { backend: "conpty", buildNumber: 21376 },
      // OSC 8 hyperlinks (e.g. Codex wraps URLs in escape sequences) are
      // activated by xterm's built-in handler. Without a custom linkHandler
      // it defaults to window.open, which only pops a useless navigation
      // dialog inside the Tauri webview. Route them through the same
      // openExternal path as plain-text links so they open the OS browser
      // (issue #345).
      linkHandler: {
        activate: (_event, uri) => {
          openExternal(uri).catch(() => {});
        },
      },
    });

    // Cell-width contract first: every pane must lay out its buffer with the
    // same Unicode/grapheme widths the IME composition preview measures with.
    // Activating here — before terminal.open(), any PTY write and any session
    // restore write — means no row is ever printed with xterm's default
    // Unicode 6 widths and then measured with this provider's.
    activateTerminalUnicodeProvider(terminal);

    const fitAddon = new FitAddon();
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
        () => useSettingsStore.getState().paste.linkJoin,
      ),
    );

    // Issue #439: bare `#123` issue/PR references. Claude Code prints these as
    // plain text (Codex wraps them in OSC 8, so xterm makes those clickable
    // natively). Detect the pattern and open the pane's GitHub repo at
    // `/issues/{n}` — GitHub redirects issues↔pulls by number, so both work.
    // Always registered; produces no links when the pane is not a GitHub repo
    // (repoBaseRef is null). Same UX as Codex, no separate setting toggle.
    terminal.registerLinkProvider(
      createPrLinkProvider(
        terminal,
        (n) => {
          const base = repoBaseRef.current;
          if (base) openExternal(`${base}/issues/${n}`).catch(() => {});
        },
        () => repoBaseRef.current,
      ),
    );

    // Issue #363 (선택 기반): 사용자가 *선택(드래그)* 한 파일/디렉토리 경로에
    // 밑줄을 긋고, 클릭하면 파일은 viewer 로 열고 디렉토리는 cwd 로 전파한다.
    // 기존의 "hover 줄 전체 토큰 stat" 방식을 제거했다(느리고 Windows 에서 동작
    // 안 함). 검증(트림/판별 + cwd 조합 + stat_path)은 onSelectionChange/pointerup
    // 시점에 **선택당 1회만** 수행하고, 검증되면 데코레이션으로 밑줄을 직접 그린다
    // (xterm linkifier hover 에 의존하면 검증 후 마우스를 나갔다 돌아와야 켜지는
    // 문제가 있어 데코레이션 방식으로 전환 — path-link-provider 주석 참고).
    const pathLink = createPathLinkController(terminal, {
      onOpenPath: (absPath) => {
        useFileViewerStore.getState().openFileViewer(absPath);
      },
      onChangeDir: (absPath) => {
        // 클릭한 디렉토리를 새 cwd 로 **제안**해 기존 중앙화 전파 경로(do_sync_cwd)에
        // 그대로 태운다. FileExplorer.navigateTo 와 동일하게:
        //   - origin 으로 **비-터미널 sentinel** 을 넘긴다 → 백엔드가 소스의 tracked
        //     cwd 를 발명(line 639)하거나 소스를 대상에서 제외하지 않는다. 클릭한
        //     pane 도 특별취급 없이 일반 대상이 된다.
        //   - **force 를 넣지 않는다** → cwd_receive 필터(filter_targets_cwd_receive)가
        //     적용되어, receive 를 켠 pane(클릭한 pane 포함)만 이동한다. dock·다른
        //     pane 도 동일 정책. (force=true 는 receive 를 무시하므로 쓰지 않는다.)
        const group = syncGroupRef.current;
        if (!group) return;
        handleLxMessage(
          JSON.stringify({
            action: "sync-cwd",
            path: absPath,
            terminal_id: `${instanceId}__pathlink`,
            group_id: group,
          }),
        ).catch((err) => {
          console.warn(`[pathLink] ${instanceId} cwd 전파 실패:`, err);
        });
      },
    });
    pathLinkControllerRef.current = pathLink;

    // 검증된 경로가 선택돼 클릭 가능할 때 포인터(손가락) 커서를 호스트에 직접
    // 적용한다. xterm 의 링크 hover 포인터는 *활성 텍스트 선택* 위에서는 선택
    // 커서(I-beam)에 밀려 적용되지 않으므로(우리 모델은 항상 선택이 떠 있다),
    // 검증 성공/해제 시 클래스를 토글해 결정적으로 처리한다.
    const setPathLinkCursor = (active: boolean) => {
      wrapperRef.current?.classList.toggle("terminal-path-link-clickable", active);
    };

    // 검증된 선택을 비우고(있으면) 밑줄 데코레이션을 거둔다. 선택 해제/변경 공통 경로.
    const clearPathLinkSelection = () => {
      setPathLinkCursor(false);
      pathLink.clear();
    };

    // 선택 settle 시점(onSelectionChange / pointerup)에 1회 호출되는 검증 흐름.
    // 동시 호출/race 를 막기 위해 토큰으로 마지막 요청만 반영한다.
    let pathLinkSelectionSeq = 0;
    const evaluatePathLinkSelection = () => {
      const settings = useSettingsStore.getState().terminal;
      if (!settings.pathLinkEnabled) {
        clearPathLinkSelection();
        return;
      }
      const t = terminalRef.current;
      if (!t) return;
      const selection = t.getSelection();
      // 비었거나 길이 초과 → 파싱 없이 기존 상태 비움.
      if (!isWithinPathLengthLimit(selection, settings.pathLinkMaxLength)) {
        clearPathLinkSelection();
        return;
      }
      const token = trimSelectionToPath(selection);
      if (!token) {
        clearPathLinkSelection();
        return;
      }
      const absPath = joinCwdPath(cwdRef.current, token);
      if (!absPath) {
        clearPathLinkSelection();
        return;
      }
      const pos = t.getSelectionPosition();
      if (!pos) {
        clearPathLinkSelection();
        return;
      }
      // 선택 좌표(0-based, end exclusive)를 1-based 절대 버퍼 좌표로 매핑한다.
      // (getSelectionPosition 과 provideLinks/ILink.range 의 좌표계 불일치 보정 —
      //  mapSelectionToPathRange 주석 참고. 여러 줄 선택은 첫 줄만 사용.)
      const rawFirstLine = selection.split(/\r?\n/, 1)[0] ?? "";
      const { bufferLine, startCol, endCol } = mapSelectionToPathRange(pos, rawFirstLine, token);

      const seq = ++pathLinkSelectionSeq;
      statPath(absPath)
        .then((info) => {
          if (seq !== pathLinkSelectionSeq) return; // 더 최신 선택이 있으면 무시.
          const action = decidePathLinkAction(info);
          if (action === "none") {
            clearPathLinkSelection();
            return;
          }
          // 커서를 먼저 켜 데코레이션 생성과 분리한다(밑줄 실패해도 커서는 동작).
          // 의도적으로 hitTest 없이 켠다: 이 검증은 드래그 선택 직후에 도착하고
          // 그 릴리스 지점은 거의 항상 선택한 경로 위이므로(=hover 중) 즉시 포인터를
          // 보여주는 게 맞다. 마우스가 경로 밖이거나 키보드 선택인 드문 경우엔 다음
          // mousemove 의 hitTest 가 곧바로 교정한다(데코 rect 는 다음 프레임에야
          // 준비돼 여기서 hitTest 해도 신뢰할 수 없다).
          setPathLinkCursor(true);
          pathLink.setVerifiedSelection({
            bufferLine,
            startCol,
            endCol,
            absPath,
            isDirectory: action === "changeDir",
          });
        })
        .catch(() => {
          if (seq !== pathLinkSelectionSeq) return;
          clearPathLinkSelection();
        });
    };
    pathLinkEvaluateRef.current = evaluatePathLinkSelection;

    terminalRef.current = terminal;

    let prevHideNativeCursor: boolean | undefined;
    let prevNativeCursorInputMode: InputMode | undefined;
    const applyNativeCursorVisibility = () => {
      const currentInputMode = inputModeRef.current;
      const hideNativeCursor =
        currentInputMode === "composer" ||
        compositionPreviewRef.current.active ||
        (stabilizeInteractiveCursorRef.current && isOverlayCaretActivity(activityRef.current));
      if (
        hideNativeCursor === prevHideNativeCursor &&
        currentInputMode === prevNativeCursorInputMode
      ) {
        return;
      }
      prevHideNativeCursor = hideNativeCursor;
      prevNativeCursorInputMode = currentInputMode;

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
      terminal.options.cursorInactiveStyle = currentInputMode === "composer" ? "none" : "outline";

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
      getCols: () => terminal.cols,
      // A blur mid-composition would otherwise drop the syllable: xterm clears the
      // helper textarea and sends nothing (measured). Route it exactly like typed
      // input so the remote-control gate still applies (issue #555).
      // `null` means the private shape moved under us (see xterm-pending-composition).
      // Fall back to "not pending": that re-opens the #555 loss for that build rather
      // than risking a duplicate syllable on every focus change, and the xterm contract
      // tests read the same fields, so a shape change fails loudly before shipping.
      getXtermPendingSend: () => readPendingCompositionSend(terminal)?.pending ?? false,
      onCommit: (text) => {
        // The blur commit now runs on the main ordering, so both exits need to be
        // visible: a gated-out commit and a failed write are silent syllable losses
        // otherwise, and they look identical to the bug this fixes.
        if (!localTerminalControlAllowed()) {
          trace("ime-composition-commit-on-blur-blocked", { text, reason: "remote-control" });
          return;
        }
        trace("ime-composition-commit-on-blur", { text });
        writeToTerminal(instanceId, text).catch((error: unknown) => {
          trace("ime-composition-commit-on-blur-failed", { text, error: String(error) });
        });
      },
      getAnchor: () => {
        // Prefer the shadow cursor only when it is actually the trusted position.
        // TUI apps (Claude Code, Codex, …) move the buffer cursor to the
        // footer/status-bar during repaints, which is why the shadow cursor exists
        // — but that reasoning does not hold everywhere, and `computeUseShadowCursor`
        // is this repo's existing predicate for "is the shadow snapshot trustworthy
        // right now".
        //
        // Reading the shadow unconditionally broke plain shells (issue #551): a
        // PowerShell prompt after `ls` emits OSC 133 `D` but no `B`, so
        // `isInputPhase` stays false and `shadow-sync-skip { reason: "inactive" }`
        // leaves the shadow a row behind the buffer. The preview then painted on the
        // previous row at column 0 — off where the user is typing, so it read as
        // "nothing appears". On a pristine prompt the two happened to coincide,
        // which is why it looked like it worked.
        //
        // `computeUseShadowCursor` alone is not the right test: it answers "is the
        // shadow snapshot trustworthy", while this call site asks "which of the two
        // is closer to the real input position". Those are not complements. A TUI
        // mid-repaint has parked the public cursor on its footer row without
        // necessarily having a sync frame or an input phase, and falling back to the
        // buffer there would paint the preview on the footer — the exact failure the
        // original comment warned about. `isRepaintInProgress` covers that gap.
        const shadow = shadowCursorRef.current;
        //
        // In the alt buffer the buffer cursor is always the authority (issue #553).
        // The shadow machine exists for the normal buffer's prompt/footer parking and
        // it *gives up* there: `getShadowSyncEligibility` returns `"alt-buffer"` and
        // skips the sync outright. But `computeUseShadowCursor` still returns true
        // whenever `hasSyncFramePosition` is set, so without this term a fullscreen TUI
        // that emits DEC 2026 would be anchored on a value the shadow machine stopped
        // maintaining — frozen at best, and if it was captured before the alt-buffer
        // switch its absolute row exceeds `rows` and the viewport guard hides the
        // preview entirely. vim happens to escape this by emitting neither OSC 133 nor
        // DEC 2026, which is a property of vim, not of the alt buffer.
        if (
          !shadow.isAltBufferActive &&
          (computeUseShadowCursor(shadow) || shadow.isRepaintInProgress)
        ) {
          return {
            cursorX: shadow.cursorX,
            cursorAbsY: shadow.cursorAbsY,
          };
        }
        const buffer = terminal.buffer.active as { cursorX?: number };
        return {
          cursorX: buffer.cursorX ?? 0,
          cursorAbsY: getBufferCursorAbsY(terminal),
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
    // Sogou/fcitx 계열 Linux IME 는 후보 선택에 쓴 Space/숫자를 compositionend
    // 전후에 일반 키 이벤트로 다시 내보낸다. xterm 의 조합 가드는 그 시점에 이미
    // 끝나 있어 literal Space/숫자가 PTY 로 새어 나간다. Linux 에서만, 그리고
    // "IME 가 소비했다는 표식(keyCode 229)" 또는 "선행 keydown 이 없는 orphan"
    // 인 경우에만 막는다 — 조합 직후 사용자가 새로 누른 키는 그대로 통과한다
    // (ADR-0060).
    const linuxImeCandidateGuard = createLinuxImeCandidateGuard({
      enabled: isLinuxHost(),
      now: () => performance.now(),
      onTrace: (event, payload) => trace(event, payload),
    });
    const handleCompositionStartForCandidate = () => linuxImeCandidateGuard.noteCompositionStart();
    const handleCompositionUpdateForCandidate = () =>
      linuxImeCandidateGuard.noteCompositionUpdate();
    const handleCompositionEndForCandidate = () => linuxImeCandidateGuard.noteCompositionEnd();
    const handleInputForCandidate = (event: Event) => {
      const inputEvent = event as InputEvent;
      linuxImeCandidateGuard.noteTextInput({
        isComposing: !!inputEvent.isComposing,
        inputType: inputEvent.inputType,
      });
    };
    const handleBlurForCandidate = () => linuxImeCandidateGuard.reset("helper-blur");
    // finalizer 가 클로저로 캡처하는 값과 같은 시점에 스냅샷한다(issue #527).
    // keypress 시점에 라이브로 읽으면, 새 조합이 시작된 뒤에는
    // compositionstart 가 이 필드를 textarea.value.length 로 덮어써 틀린 값이 된다.
    let capturedCompositionStart: number | null = null;
    const handleCompositionEndForCommitRace = () => {
      capturedCompositionStart = readCompositionStart(terminal);
    };
    const handleCompositionStartForCommitRace = () => {
      capturedCompositionStart = null;
    };
    // 조합 lifecycle 은 xterm 의 CompositionHelper 가 계속 소유한다. 여기서는
    // 관찰만 하고 조합 문자열·commit 경로는 건드리지 않는다.
    const attachCandidateGuardListeners = (target: HTMLTextAreaElement) => {
      target.addEventListener("compositionstart", handleCompositionStartForCandidate);
      target.addEventListener("compositionupdate", handleCompositionUpdateForCandidate);
      target.addEventListener("compositionend", handleCompositionEndForCandidate);
      target.addEventListener("compositionstart", handleCompositionStartForCommitRace);
      target.addEventListener("compositionend", handleCompositionEndForCommitRace);
      target.addEventListener("input", handleInputForCandidate);
      target.addEventListener("blur", handleBlurForCandidate);
    };
    const detachCandidateGuardListeners = (target: HTMLTextAreaElement) => {
      target.removeEventListener("compositionstart", handleCompositionStartForCandidate);
      target.removeEventListener("compositionupdate", handleCompositionUpdateForCandidate);
      target.removeEventListener("compositionend", handleCompositionEndForCandidate);
      target.removeEventListener("compositionstart", handleCompositionStartForCommitRace);
      target.removeEventListener("compositionend", handleCompositionEndForCommitRace);
      target.removeEventListener("input", handleInputForCandidate);
      target.removeEventListener("blur", handleBlurForCandidate);
    };

    let overlayCaretFrame: number | undefined;
    let helperTextarea: HTMLTextAreaElement | null = null;

    // -- native IME candidate window anchor (issue #532, ADR-0061) -------------
    // helper textarea 의 **위치만** 임시로 옮긴다. value·focus·composition
    // lifecycle 은 계속 xterm 소유(ADR-0053/0054)이며 여기서 읽지도 쓰지도
    // 않는다. 옮긴 뒤에는 반드시 원래 inline style 로 되돌린다.
    const helperAnchorKeeper = createHelperAnchorKeeper({
      onTrace: (event, payload) => trace(event, payload),
    });
    const restoreHelperAnchor = (reason: string) => helperAnchorKeeper.release(reason);
    const syncHelperAnchor = (input: {
      anchorCell: AnchorCell;
      publicCell: AnchorCell;
      screenEl: HTMLElement | null;
      targetRect: DOMRect;
      cols: number;
      rows: number;
    }) => {
      const helper = helperTextarea;
      // 조합 중이 아니면 후보창도 없다 — 평소에는 xterm 배치를 건드리지 않는다.
      if (!helper || !compositionPreviewRef.current.active || !input.screenEl) {
        restoreHelperAnchor("not-composing");
        return;
      }
      if (!shouldSyncHelperAnchor(input.publicCell, input.anchorCell)) {
        // 두 커서가 일치하면 xterm 배치가 이미 맞다.
        restoreHelperAnchor("cursors-agree");
        return;
      }
      const metrics = computeCellMetrics(
        input.targetRect.width,
        input.targetRect.height,
        input.cols,
        input.rows,
      );
      if (!metrics) {
        // geometry 미확정도 앵커를 신뢰할 수 없는 상태다 — 옮겨둔 위치를 남기지 않는다.
        restoreHelperAnchor("no-metrics");
        return;
      }
      const screenRect = input.screenEl.getBoundingClientRect();
      const style = computeHelperAnchorStyle({
        anchorCell: clampAnchorCell(input.anchorCell, input.cols, input.rows),
        metrics,
        // helper 의 offsetParent 가 `.xterm-screen` 이므로 캔버스 원점을 그 기준으로 잡는다.
        originLeft: input.targetRect.left - screenRect.left,
        originTop: input.targetRect.top - screenRect.top,
        devicePixelRatio: window.devicePixelRatio,
      });
      // xterm 의 CompositionHelper 는 조합 중 같은 style 을 매 렌더 + 자기 재예약
      // setTimeout(0) 으로 다시 쓴다(실측). 한 번 쓰는 것으로는 last-writer-wins
      // 경합에서 지므로 keeper 가 style 변경을 감시해 앵커를 유지한다 (ADR-0061).
      helperAnchorKeeper.apply(helper, style);
    };
    const updateOverlayCaret = () => {
      const overlay = overlayCaretRef.current;
      const previewEl = compositionPreviewRefEl.current;
      const host = wrapperRef.current;
      const term = terminalRef.current;
      if (!overlay || !previewEl || !host || !term) return;

      const hideOverlay = () => {
        overlay.style.opacity = "0";
        previewEl.style.opacity = "0";
        // 오버레이가 숨는 경로(비포커스·스크롤백·geometry 미확정)는 후보창 앵커도
        // 신뢰할 수 없다. 옮겨둔 helper 위치를 여기서 반드시 원복한다 —
        // 아래 sync 호출은 이 조기 반환들보다 뒤에 있다.
        restoreHelperAnchor("overlay-hidden");
      };

      // Only the conditions under which *nothing* may be painted belong here.
      // `stabilizeInteractiveCursor` and `isOverlayCaretActivity` are caret-policy
      // inputs, not visibility conditions — returning on them hid the composition
      // preview in every non-Codex pane (issue #551). They are still passed to
      // `resolveVisualCaretOwner` below, which returns "hidden" for them whenever no
      // composition is in flight, so the caret behaviour is unchanged.
      if (!openedRef.current || !isFocusedRef.current || syncOutputActiveRef.current) {
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

      const shadowCursor = shadowCursorRef.current;
      const caretOwner = resolveVisualCaretOwner({
        opened: openedRef.current,
        focused: isFocusedRef.current,
        stabilizeInteractiveCursor: stabilizeInteractiveCursorRef.current,
        overlayActivity: isOverlayCaretActivity(activityRef.current),
        syncOutputActive: syncOutputActiveRef.current,
        isAltBufferActive: shadowCursor.isAltBufferActive,
        viewportScrolledUp: isTerminalScrolledUp(term),
        compositionActive: compositionPreviewRef.current.active,
        cursorHidden: shadowCursor.isCursorHidden,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        isInputPhase: shadowCursor.isInputPhase,
      });
      if (caretOwner === "alt-buffer" || caretOwner === "hidden") {
        hideOverlay();
        trace("overlay-hidden", { reason: caretOwner, shadowCursor });
        return;
      }

      // Skip when already cleared — assigning `textContent` replaces
      // child nodes even when the value is unchanged, and this runs on
      // every rAF paint outside composition.
      if (!compositionPreviewRef.current.active && previewEl.textContent) {
        previewEl.style.opacity = "0";
        previewEl.replaceChildren();
      }

      // Post-frame settle window: the shadow position right after a DEC
      // 2026 flush is only a fallback estimate (Codex's authoritative
      // cursor park arrives ~15 ms later as `?25l` CUP `?25h`). Keep
      // the overlay at its previous painted position instead of
      // repainting with an estimate that may sit on the footer row.
      // Composition preview and sustained DECTCEM hide bypass the
      // freeze — see `shouldFreezeOverlayForPark` for why each must
      // reach paint immediately.
      if (
        shouldFreezeOverlayForPark(shadowCursorRef.current, compositionPreviewRef.current.active)
      ) {
        trace("overlay-frozen", { reason: "park-pending" });
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
          // Both the container and the rows come from the layout's normalized anchor,
          // so the offsets cancel by construction: container at `anchorColumn`, each
          // row at `startColumn - anchorColumn`, absolute column `startColumn`. An
          // earlier form derived the container's normalization here instead, which
          // double-counted the row offset and dropped the preview a row below its own
          // caret (issue #551). Reading `anchorBufferX` as a screen column is the
          // mistake to avoid — it can sit at or past the right edge.
          const anchorX = previewLayout.anchorColumn;
          const anchorY =
            compositionPreview.anchorBufferAbsY + previewLayout.anchorRowOffset - baseY;
          const previewRows = previewLayout.rows;
          previewEl.style.opacity = "1";
          previewEl.style.transform = `translate(${Math.round(targetRect.left - hostRect.left + anchorX * cellWidth)}px, ${Math.round(
            targetRect.top - hostRect.top + anchorY * cellHeight,
          )}px)`;
          previewEl.style.width = `${Math.max(
            cellWidth,
            ...previewRows.map((row) => row.cellWidth * cellWidth),
          )}px`;
          previewEl.style.height = `${Math.max(
            1,
            (Math.max(
              0,
              ...previewRows.map((row) => row.rowOffset - previewLayout.anchorRowOffset),
            ) +
              1) *
              cellHeight,
          )}px`;
          previewEl.style.fontSize = `${term.options.fontSize ?? Math.max(1, cellHeight)}px`;
          previewEl.style.lineHeight = `${Math.max(1, cellHeight)}px`;

          for (let index = 0; index < previewRows.length; index += 1) {
            const row = previewRows[index];
            let rowEl = previewEl.children.item(index) as HTMLDivElement | null;
            if (!rowEl) {
              rowEl = document.createElement("div");
              rowEl.className = "terminal-composition-preview-row";
              previewEl.appendChild(rowEl);
            }
            if (rowEl.textContent !== row.text) {
              rowEl.textContent = row.text;
            }
            rowEl.style.width = `${Math.max(cellWidth, row.cellWidth * cellWidth)}px`;
            rowEl.style.height = `${Math.max(1, cellHeight)}px`;
            rowEl.style.transform = `translate(${Math.round(
              (row.startColumn - anchorX) * cellWidth,
            )}px, ${Math.round((row.rowOffset - previewLayout.anchorRowOffset) * cellHeight)}px)`;
          }
          while (previewEl.children.length > previewRows.length) {
            previewEl.lastElementChild?.remove();
          }
        } else {
          previewEl.style.opacity = "0";
          previewEl.replaceChildren();
        }
      } else {
        previewEl.style.opacity = "0";
        previewEl.replaceChildren();
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

      // OS 후보창은 포커스된 helper textarea 의 DOM 위치에서 뜨고, xterm 은 그
      // textarea 를 public buffer cursor 에 둔다. TUI repaint 로 두 커서가
      // 갈리면 preview 는 맞아도 후보창만 다른 행에 뜬다. 여기서 같은
      // cursorX/cursorY 를 넘겨 앵커 계약을 하나로 유지한다 (ADR-0061).
      //
      // viewport 범위 체크 **뒤**에 온다. 앞에 두면 shadow cursor 행이 뷰포트
      // 밖일 때 매 프레임 이동 → hideOverlay 의 원복이 반복돼, 조합 중 IME
      // 안정성이 가장 중요한 구간에서 불필요한 churn 이 생긴다.
      syncHelperAnchor({
        anchorCell: { column: cursorX, row: cursorY },
        publicCell: { column: term.buffer.active.cursorX, row: term.buffer.active.cursorY },
        screenEl: screen,
        targetRect,
        cols: term.cols,
        rows: term.rows,
      });

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
    // Composer ↑/↓ routing signal. "At prompt" ≙ no command running, which the
    // shell marks with OSC 133;D (see backend: last OSC D = prompt, C = running).
    // NOT `isInputPhase` — that needs 133;B, which some shells (PowerShell) skip,
    // so it stays false at the prompt and history recall would never fire.
    const markShellPrompt = (atPrompt: boolean) => {
      if (atShellPromptRef.current !== atPrompt) {
        atShellPromptRef.current = atPrompt;
        setAtShellPrompt(atPrompt);
      }
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

    let parkSettleTimer: number | undefined;
    let parkSettleDeadline: number | undefined;
    let parkSettleUsesAbsoluteDeadline = false;
    let parkSettleDeferrals = 0;
    const cancelParkSettleTimer = () => {
      if (parkSettleTimer !== undefined) {
        clearTimeout(parkSettleTimer);
        parkSettleTimer = undefined;
      }
    };
    const clearParkSettleTimer = () => {
      cancelParkSettleTimer();
      parkSettleDeadline = undefined;
      parkSettleUsesAbsoluteDeadline = false;
    };
    // Legacy writes restart this timer for each DEC 2026 flush. Stabilized
    // Native Windows transactions instead retain the absolute D_park
    // deadline selected when their synchronized-output frame was recognized.
    // A legacy TUI that streams frames at < PARK_SETTLE_TIMEOUT_MS intervals
    // *without* ever parking would keep the overlay frozen indefinitely. Codex
    // parks after every frame (the whole reason this layer exists) and
    // `isOverlayCaretActivity` is Codex-only, so there is no exposure
    // today — revisit if another ratatui TUI joins the overlay set.
    const armParkSettleTimer = () => {
      cancelParkSettleTimer();
      const delay = Math.max(
        0,
        parkSettleUsesAbsoluteDeadline && parkSettleDeadline !== undefined
          ? parkSettleDeadline - monotonicNow()
          : PARK_SETTLE_TIMEOUT_MS,
      );
      parkSettleTimer = window.setTimeout(() => {
        parkSettleTimer = undefined;
        const shadowCursor = shadowCursorRef.current;
        if (!shadowCursor.parkPending) {
          parkSettleDeadline = undefined;
          parkSettleUsesAbsoluteDeadline = false;
          return;
        }
        if (shadowCursor.isDec2026FrameOpen) {
          if (!parkSettleUsesAbsoluteDeadline && parkSettleDeferrals < PARK_SETTLE_MAX_DEFERRALS) {
            // The next DEC 2026 frame is mid-flight. Firing now would
            // consume `parkPending` and schedule a paint that the
            // frame gate hides — a one-frame overlay blink. Defer and
            // let the frame's own `?2026l` restart the settle cycle
            // with a fresh snapshot.
            parkSettleDeferrals += 1;
            armParkSettleTimer();
            return;
          }
          // The frame has stayed open for the whole deferral budget.
          // Release only the post-frame fallback freeze so the overlay
          // cannot remain stuck forever. The parser frame stays open
          // until a real `?2026l`; closing it here would make a later
          // in-frame `?25h` look like an authoritative cursor park.
          trace("park-settle-open-frame-fallback", { deferrals: parkSettleDeferrals });
        }
        Object.assign(shadowCursor, applyParkSettleTimeoutToShadowCursor(shadowCursor));
        trace("park-settle-timeout", {
          cursorX: shadowCursor.cursorX,
          cursorAbsY: shadowCursor.cursorAbsY,
        });
        scheduleOverlayCaretUpdate();
        parkSettleDeadline = undefined;
        parkSettleUsesAbsoluteDeadline = false;
      }, delay);
    };
    const startParkSettleTimer = (deadline?: number) => {
      parkSettleDeferrals = 0;
      parkSettleUsesAbsoluteDeadline = deadline !== undefined;
      parkSettleDeadline = deadline ?? monotonicNow() + PARK_SETTLE_TIMEOUT_MS;
      armParkSettleTimer();
    };
    const syncOutputSetDisposable = parser?.registerCsiHandler?.(
      { prefix: "?", final: "h" },
      (params) => {
        if (hasDecModeParam(params, 2026)) {
          setSyncOutputCursorVisibility(true);
          // Open the parser frame even before Codex activity is
          // classified. The helper snapshots coordinates only for the
          // overlay activity, but the stream boundary itself is global.
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
        if (
          hasDecModeParam(params, 1049) ||
          hasDecModeParam(params, 1047) ||
          hasDecModeParam(params, 47)
        ) {
          shadowCursorRef.current.isAltBufferActive = true;
          shadowCursorRef.current.hasSyncFramePosition = false;
          shadowCursorRef.current.frameSavedCursorX = undefined;
          shadowCursorRef.current.frameSavedCursorAbsY = undefined;
          shadowCursorRef.current.parkPending = false;
          shadowCursorRef.current.isDec2026FrameOpen = false;
          clearParkSettleTimer();
          setInputPhase(false);
        }
        // DECTCEM show — processed *after* the mode branches above so a
        // combined-param CSI (`?2026;25h`, `?1049;25h`) applies its
        // mode state first and the show is then classified against the
        // already-updated state (in-frame / alt-buffer shows are
        // visibility-only). Outside a DEC 2026 frame on the normal
        // buffer this is Codex's cursor *park* (`?25l` CUP `?25h` as
        // its own chunk) — the authoritative input-cursor position.
        // See `applyDectcemShowToShadowCursor` / `isDectcemShowPark`.
        if (hasDecModeParam(params, 25)) {
          const prev = shadowCursorRef.current;
          const activeBuffer = terminal.buffer.active as { cursorX?: number };
          const next = applyDectcemShowToShadowCursor(
            prev,
            activityRef.current,
            activeBuffer.cursorX ?? 0,
            getBufferCursorAbsY(terminal),
          );
          if (next !== prev) {
            Object.assign(shadowCursorRef.current, next);
            if (isDectcemShowPark(prev)) {
              clearParkSettleTimer();
              trace("dectcem-park", {
                cursorX: next.cursorX,
                cursorAbsY: next.cursorAbsY,
              });
            }
            scheduleOverlayCaretUpdate();
          }
        }
        return false;
      },
    );
    const syncOutputResetDisposable = parser?.registerCsiHandler?.(
      { prefix: "?", final: "l" },
      (params) => {
        if (hasDecModeParam(params, 25)) {
          const prev = shadowCursorRef.current;
          const next = applyDectcemHideToShadowCursor(prev, activityRef.current);
          if (next !== prev) {
            Object.assign(shadowCursorRef.current, next);
            scheduleOverlayCaretUpdate();
          }
        }
        if (hasDecModeParam(params, 2026)) {
          setSyncOutputCursorVisibility(false);
          const overlayActivity = isOverlayCaretActivity(activityRef.current);
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
          if (overlayActivity) {
            // TUI DEC 2026 frame just flushed → snapshot a *fallback*
            // shadow position (pre-frame save, else buffer cursor).
            // The authoritative position is the cursor park that
            // follows; see `shadow-cursor-state.ts` for why stale
            // OSC 133 flags from a prior shell session must be
            // cleared here.
            // `parkPending` is now set: overlay repaints are frozen at
            // the last painted position until Codex's cursor park
            // arrives (authoritative) or the settle window expires
            // (fallback to the snapshot taken above).
            startParkSettleTimer(currentParsingParkDeadline);
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
      if (
        shadowCursor.isAltBufferActive ||
        shadowCursor.isDec2026FrameOpen ||
        syncOutputActiveRef.current
      ) {
        return;
      }
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
      firstRenderReady = true;
      settleStartupIfReady();
      if (readyGenerationRef.current !== terminalGeneration) {
        readyGenerationRef.current = terminalGeneration;
        setReadyGeneration(terminalGeneration);
      }
      scheduleOverlayCaretUpdate();
    });
    // Keep viewport-dependent presentation in sync. xterm fires onScroll on
    // every wheel step / scrollToBottom; reading baseY vs viewportY tells us
    // whether the user is pinned to the live bottom. The Codex overlay caret
    // is hidden in scrollback because its shadow coordinates describe the live
    // screen, not an arbitrary historical viewport.
    const refreshViewportPresentation = () => {
      setShowScrollToBottom(isTerminalScrolledUp(terminal));
      scheduleOverlayCaretUpdate();
    };
    const scrollDisposable = terminal.onScroll?.(refreshViewportPresentation);
    // Issue #530: 앱 비활성화(Alt-Tab 등)에서 webview 가 helper textarea 의 실제
    // DOM focus 를 body/null 로 떨어뜨려도 store 의 pane focus 는 그대로이므로
    // 어떤 effect 도 재실행되지 않는다 → 복귀 후 첫 키/첫 IME 조합이 유실된다.
    // pane focus 를 DOM focus 와 동일시하지 않고, blur 시점에 이 pane 의 helper
    // 가 정말 focus 를 갖고 있었을 때만 identity 를 기억해 복귀 다음 프레임에
    // 복원한다. 복귀 사이 다른 UI(모달·검색·설정·다른 pane)가 focus 를 얻으면
    // 절대 빼앗지 않는다 (ADR-0057).
    const focusOwnership = createTerminalFocusOwnership({
      getContainer: () => wrapperRef.current,
      onTrace: (event, payload) => trace(event, payload),
    });
    focusOwnershipRef.current = focusOwnership;
    const handleAppBlurForFocusOwnership = () => {
      focusOwnership.captureOnAppBlur();
    };
    const handleAppFocusForFocusOwnership = () => {
      focusOwnership.reclaimOnAppFocus();
    };
    // 재활성화 클릭이 다른 UI 로 향했을 때(포커스를 가져가지 않는 요소여도)
    // 예약된 복원이 터미널로 focus 를 끌어오지 않게 소유권을 즉시 버린다.
    const handlePointerDownForFocusOwnership = (event: PointerEvent) => {
      focusOwnership.releaseForPointerTarget(event.target);
    };
    // webview 가 window blur 를 발행하기 *전에* DOM focus 를 body 로 되돌리는
    // 순서도 있다. 그 경우 blur 시점의 activeElement 만 보면 아무것도 기억하지
    // 못하므로, "focus 를 아무데도 넘기지 않고" 빠진 helper 를 fallback 으로
    // 들고 있는다. 실제 요소로 focus 가 옮겨간 focusout 은 기억하지 않는다.
    const handleFocusOutForFocusOwnership = (event: FocusEvent) => {
      focusOwnership.noteFocusOut(event.target, event.relatedTarget);
    };
    const focusOwnershipSurface = wrapperRef.current;
    window.addEventListener("blur", handleAppBlurForFocusOwnership);
    window.addEventListener("focus", handleAppFocusForFocusOwnership);
    window.addEventListener("pointerdown", handlePointerDownForFocusOwnership, true);
    focusOwnershipSurface?.addEventListener("focusout", handleFocusOutForFocusOwnership);

    // 사용자가 OS 입력 소스 전환 chord 를 바인딩했을 때, 그 물리 키에서 파생된
    // keydown/keypress/keyup 과 비조합 텍스트 삽입이 PTY 로 새지 않게 한다.
    // 기본값은 미할당이라 아무것도 바인딩하지 않으면 완전한 no-op 이다 (ADR-0059).
    const osInputSourceChord = createOsInputSourceChordGuard({
      matchesChord: (event) =>
        matchesKeybinding(event as unknown as KeyboardEvent, "terminal.osInputSourceSwitch"),
      onTrace: (event, payload) => trace(event, payload),
    });
    // helper 의 비조합 텍스트 삽입은 keydown 을 건너뛴 뒤에도 남는다. xterm 은
    // textarea `input` 을 듣고 `_keyUp` 이 `_keyDownSeen` 을 먼저 내리므로, keyup
    // 이후 도착한 삽입은 xterm 자체 게이트를 통과해 PTY 로 간다. 여기서는
    // preventDefault 를 한다 — OS 전환은 이미 keydown 에서 결정됐고, 남은 것은
    // textarea 로 들어갈 문자뿐이다.
    const handleBeforeInputForChord = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (
        !osInputSourceChord.shouldBlockTextInput({
          isComposing: !!inputEvent.isComposing,
          data: inputEvent.data,
          inputType: inputEvent.inputType,
        })
      ) {
        return;
      }
      event.preventDefault();
      trace("os-input-source-chord-text-input-blocked", { inputType: inputEvent.inputType });
    };
    // 조합 중이 아니어도 chord 가 걸려 있지 않으면 위 핸들러는 즉시 반환한다.
    const handleBlurForChord = () => osInputSourceChord.reset("helper-blur");

    const bindHelperTextareaEvents = () => {
      const nextHelperTextarea = terminal.element?.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;
      if (!nextHelperTextarea || nextHelperTextarea === helperTextarea) return;
      if (helperTextarea) {
        // 옮겨둔 위치를 남긴 채 helper 를 바꾸면 stale inline style 이 남는다.
        restoreHelperAnchor("helper-replaced");
        helperTextarea.removeEventListener("beforeinput", handleBeforeInputForChord);
        helperTextarea.removeEventListener("blur", handleBlurForChord);
        detachCandidateGuardListeners(helperTextarea);
      }
      helperTextarea = nextHelperTextarea;
      compositionController.bind(helperTextarea);
      // helper 가 바뀌면 진행 중이던 후보 window 도 추적 불가 → 버린다.
      linuxImeCandidateGuard.reset("helper-replaced");
      attachCandidateGuardListeners(helperTextarea);
      // xterm 이 helper 를 교체하면 이전 helper 의 focus 소유권 기록은 stale 이다.
      focusOwnership.notifyHelperBound(helperTextarea);
      // helper 가 바뀌면 진행 중이던 chord press 도 추적 불가 → 버린다.
      osInputSourceChord.reset("helper-replaced");
      helperTextarea.addEventListener("beforeinput", handleBeforeInputForChord);
      helperTextarea.addEventListener("blur", handleBlurForChord);
      scheduleOverlayCaretUpdate();
    };

    // view 인스턴스 폰트 줌 조정 (zoomIn/zoomOut 공용). paneId가 없으면 no-op.
    const adjustZoom = (delta: number) => {
      if (!paneId) return;
      const overrides = useOverridesStore.getState();
      const currentFont = useSettingsStore
        .getState()
        .resolveFont(profile, overrides.getViewOverride(paneId));
      const newSize = Math.max(FONT_ZOOM_MIN, Math.min(FONT_ZOOM_MAX, currentFont.size + delta));
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
      if (!localTerminalControlAllowed()) return false;

      // 모두에서 이 핸들러를 보지만 아래 `e.type !== "keydown"` 조기 반환은
      // keypress·keyup 을 그대로 통과시킨다 — 두 guard 가 막는 누출 경로가 바로
      // 거기다. 순서는 **명시 바인딩이 먼저**다: OS 전환 chord 는 사용자가 직접
      // 지정한 키라 조합 문맥과 무관하게 소유권이 확정돼 있고, 후보 guard 는
      // compositionend 문맥으로 추론한다. 추론이 명시 지정을 덮지 않게 한다.
      if (e.type === "keydown" || e.type === "keypress" || e.type === "keyup") {
        if (
          osInputSourceChord.shouldBlockKey({
            type: e.type,
            code: e.code,
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            repeat: e.repeat,
          })
        ) {
          // preventDefault 하지 않는다 — OS 가 입력 소스를 전환해야 한다.
          return false;
        }

        const candidateDecision = linuxImeCandidateGuard.decideKey({
          type: e.type,
          code: e.code,
          key: e.key,
          keyCode: e.keyCode,
          repeat: e.repeat,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        });
        if (candidateDecision.block) {
          // preventDefault 는 helper textarea 를 변형시키는 이벤트에만 건다.
          if (candidateDecision.preventDefault) e.preventDefault();
          return false;
        }
      }

      // xterm 의 조합 finalizer 는 commit 텍스트를 setTimeout(0) 안에서 읽어
      // 보낸다. 그 타이머가 돌기 전에 도착한 keypress 는 같은 문자를 한 번 더
      // 보내 중복이 된다(issue #527, 실제 xterm 경로에서 재현됨). pending
      // commit 이 이미 그 문자를 담고 있을 때만 keypress 를 막는다 — 애매하면
      // 전달해서 사용자가 그 사이에 새로 누른 문자를 삼키지 않는다 (ADR-0062).
      if (e.type === "keypress") {
        const pendingSend = readPendingCompositionSend(terminal);
        const live = pendingSend?.live ?? null;
        const raceDecision = decideCommitRace({
          pending: !!pendingSend?.pending,
          composing: !!pendingSend?.composing,
          // `compositionStart` 는 compositionend 시점 스냅샷을 쓴다 — finalizer 가
          // 클로저로 캡처한 값과 같은 시점이다. keypress 시점의 라이브 필드는
          // 새 조합이 시작되면 이미 덮어써져 있다.
          state:
            live && capturedCompositionStart !== null
              ? { ...live, compositionStart: capturedCompositionStart }
              : null,
          keypress: e,
        });
        if (raceDecision.suppress) {
          // preventDefault 가 필수다. xterm 의 `_keyPress` 는 커스텀 핸들러가
          // false 면 즉시 return 해 `cancel(e)` 에 도달하지 않고, `cancel` 자체도
          // 기본 옵션(`cancelEvents: false`)에서 no-op 이다. 취소하지 않으면
          // 브라우저가 그 문자를 helper textarea 에 삽입하고, xterm 은
          // compositionend 후 textarea 를 비우지 않으므로 deferred finalizer 의
          // slice 가 "가가" 를 읽어 중복이 그대로 남는다.
          e.preventDefault();
          trace("composition-commit-race-suppressed", { reason: raceDecision.reason });
          return false;
        }
      }

      if (e.type !== "keydown") return true;
      if (isLxShortcut(e)) return false;

      // In composer mode, keyboard focus belongs to the native textarea.
      // xterm-generated protocol replies do not pass this keyboard handler and
      // remain available through onData below.
      if (inputModeRef.current === "composer") return false;

      // 한/영·한자 등 IME 모드 전환 키가 조합 중 xterm 에 들어가면
      // CompositionHelper 가 stale 범위로 강제 finalize 해 이미 커밋된
      // 음절을 재전송한다(한글 중복 입력). xterm 진입 자체를 차단한다 —
      // preventDefault 는 하지 않으므로 OS IME 모드 전환은 그대로 동작.
      if (shouldBlockTerminalKeyDuringIme(compositionPreviewRef.current.active, e)) {
        return false;
      }

      if (shouldDeferTerminalKeyToIme(compositionPreviewRef.current.active, e)) {
        return true;
      }

      if (matchesKeybinding(e, "terminal.paste")) {
        // runTerminalPaste honors the smartPaste toggle internally and falls
        // back to plain clipboard paste when it's off, so override bindings
        // like Ctrl+Shift+V still work regardless of the toggle.
        e.preventDefault();
        runTerminalPaste(writeStructuredPaste, profile);
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
      // onKey is user input only; emulator-generated onData (OSC replies, focus
      // reporting) must not dismiss requiresAction notifications as if the user
      // had responded. Keep the entry policy aligned with ADR-0010/0012.
      scheduleShadowCursorSync();
      dismissTerminalResponseNotification(instanceId);
      if (outerEl) outerEl.style.cursor = "none";
      onKeyboardActivityRef.current?.();
    });
    const handleKeyDown = () => {
      if (outerEl) outerEl.style.cursor = "none";
      onKeyboardActivityRef.current?.();
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (outerEl) outerEl.style.cursor = "";
      // #363: 밑줄(검증된 경로) 영역 위에서만 포인터 커서. 벗어나면 원래 커서.
      setPathLinkCursor(pathLink.hitTest(e.clientX, e.clientY));
    };
    outerEl?.addEventListener("keydown", handleKeyDown);
    outerEl?.addEventListener("mousemove", handleMouseMove);

    // #363: 밑줄(검증된 경로) 클릭으로 열기/이동. 데코레이션은 pointer-events:none
    // 이라 mousedown/up 은 그대로 xterm 으로 흘러가 선택/드래그가 정상 동작한다.
    // 여기서는 관찰만 하여 — 밑줄 위에서 시작한 '클릭'(드래그 아님)이면 캡처한
    // 경로를 연다(파일=viewer, 디렉토리=cwd 전파). 드래그면 무시해 일반 재선택이
    // 되게 두고, 경로는 onSelectionChange 가 새로 평가/해제한다. 클릭 시 xterm 이
    // 선택을 지워 current 가 비므로, 경로는 mousedown 시점에 캡처해 둔다.
    let pathLinkPress: { sel: VerifiedPathSelection; x: number; y: number } | null = null;
    const PATH_LINK_CLICK_SLOP = 4;
    const handlePathLinkMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) {
        pathLinkPress = null;
        return;
      }
      const sel = pathLink.getCurrent();
      pathLinkPress =
        sel && pathLink.hitTest(e.clientX, e.clientY) ? { sel, x: e.clientX, y: e.clientY } : null;
    };
    const handlePathLinkMouseUp = (e: MouseEvent) => {
      const press = pathLinkPress;
      pathLinkPress = null;
      if (!press) return;
      const moved =
        Math.abs(e.clientX - press.x) > PATH_LINK_CLICK_SLOP ||
        Math.abs(e.clientY - press.y) > PATH_LINK_CLICK_SLOP;
      if (moved) return; // 드래그 → 열지 않음(재선택 의도).
      pathLink.activate(press.sel);
    };
    // capture 단계로 xterm 핸들러보다 먼저 관찰(전파는 막지 않는다).
    outerEl?.addEventListener("mousedown", handlePathLinkMouseDown, true);
    window.addEventListener("mouseup", handlePathLinkMouseUp);

    // Copy-on-select: auto-copy to clipboard when text is selected.
    // `runTerminalCopy` handles the has-selection guard and smart-indent
    // branching, keeping this path in lockstep with Ctrl+C and right-click.
    terminal.onSelectionChange(() => {
      if (useSettingsStore.getState().terminal.copyOnSelect) {
        runTerminalCopy(terminal);
      }
      // Issue #363: 선택이 바뀔 때마다 path-link 검증(선택당 stat 1회)을 갱신한다.
      // copyOnSelect 와 독립적으로 동작(off 여도 링크는 켜질 수 있음).
      pathLinkEvaluateRef.current?.();
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
    //
    // The one-shot watcher is tracked so it can be torn down on cleanup: if
    // this terminal unmounts mid-drag (before pointerup fires) the listener
    // would otherwise linger on window and run a copy against a disposed
    // terminal on some later, unrelated release. We also drop any prior
    // watcher when a fresh pointerdown arrives without an intervening
    // pointerup (missed/cancelled release).
    let pointerUpWatcher: (() => void) | null = null;
    const handlePointerDown = () => {
      if (pointerUpWatcher) window.removeEventListener("pointerup", pointerUpWatcher);
      const onWindowPointerUp = () => {
        pointerUpWatcher = null;
        // Issue #363: 드래그 종료 시 path-link 검증을 settle(선택당 stat 1회).
        pathLinkEvaluateRef.current?.();
        if (!useSettingsStore.getState().terminal.copyOnSelect) return;
        runTerminalCopy(terminal);
      };
      pointerUpWatcher = onWindowPointerUp;
      window.addEventListener("pointerup", onWindowPointerUp, { once: true });
    };
    outerEl?.addEventListener("pointerdown", handlePointerDown);

    // Issue #352: 풀스크린 TUI(codex 등)가 마우스 트래킹을 켜면 클릭이 앱으로
    // 전달되어 xterm 의 링크 활성화(linkHandler/WebLinksAddon/linkProvider)가
    // 트리거되지 않는다. 다수 터미널의 관례대로 Shift/Alt+클릭 시 마우스
    // 리포팅을 우회해 로컬에서 링크를 연다. capture 단계에서 가로채 링크를
    // 찾으면 즉시 openExternal 하고 이벤트 전파를 막아(앱으로 미전달) 일반
    // 셸·TUI 모두에서 동일하게 동작하도록 한다. 링크가 없으면 그대로 흘려
    // 보내 기존 선택/드래그 동작을 해치지 않는다.
    const handleModifierLinkClick = (event: MouseEvent) => {
      if (!isModifierLinkClick(event)) return;
      const coords = getClickCellCoords(terminal, event);
      if (!coords) return;
      const [col, viewportRow] = coords; // 1-based
      const viewportY = (terminal.buffer.active as { viewportY?: number }).viewportY ?? 0;
      const clickedLineNumber = viewportY + viewportRow; // 1-based 버퍼 라인
      const buffer = terminal.buffer.active;

      // 들여쓰기 결합 탐지를 위해 클릭 줄 주변 윈도우를 수집(±10줄).
      const windowSize = 10;
      const startLine = Math.max(1, clickedLineNumber - windowSize);
      const endLine = Math.min(buffer.length, clickedLineNumber + windowSize);
      const lines: IndentedLineInfo[] = [];
      for (let y = startLine; y <= endLine; y++) {
        const bufLine = buffer.getLine(y - 1);
        if (!bufLine) continue;
        lines.push({
          text: bufLine.translateToString(),
          isWrapped: bufLine.isWrapped,
          lineNumber: y,
        });
      }

      const oscLinkUri = getOscLinkUriAtCell(terminal, clickedLineNumber - 1, col - 1);
      const uri = resolveLinkAtCell({
        oscLinkUri,
        lines,
        clickedLineNumber,
        col,
        enableIndentedJoin: useSettingsStore.getState().paste.linkJoin,
        repoBase: repoBaseRef.current, // #439: 평문 #123 → issues URL
      });
      if (!uri) return;

      // 링크를 찾았다 → 클릭이 TUI 로 전달되지 않도록 차단하고 브라우저로 연다.
      event.preventDefault();
      event.stopPropagation();
      (
        event as MouseEvent & { stopImmediatePropagation?: () => void }
      ).stopImmediatePropagation?.();
      openExternal(uri).catch(() => {});
    };
    const wrapperEl = wrapperRef.current;
    wrapperEl?.addEventListener("mousedown", handleModifierLinkClick, true);

    const markHumanDataEmission = () => {
      humanDataEmissionDepth += 1;
      queueMicrotask(() => {
        humanDataEmissionDepth = Math.max(0, humanDataEmissionDepth - 1);
      });
    };
    const humanDataEvents = [
      "keydown",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
      "mousedown",
      "mouseup",
      "wheel",
      "focusin",
      "focusout",
    ] as const;
    for (const eventName of humanDataEvents) {
      wrapperEl?.addEventListener(eventName, markHumanDataEmission, true);
    }

    const xtermUserInputOriginDisposable = subscribeXtermUserInputOrigin(terminal, () => {
      pendingXtermUserInputOrigins += 1;
      // CoreService normally fires onData synchronously next. Do not let a
      // broken/changed internal contract poison a later parser reply.
      queueMicrotask(() => {
        pendingXtermUserInputOrigins = Math.max(0, pendingXtermUserInputOrigins - 1);
      });
    });
    const userInputOriginReliable = xtermUserInputOriginDisposable !== undefined;

    // Public xterm.onData omits CoreService's `wasUserInput`. The pinned
    // CoreService signal identifies delayed IME commits exactly; capture events
    // additionally cover focus reports that xterm emits without wasUserInput.
    // Without the internal signal, ambiguous live-write data stays human.
    terminal.onData((data) => {
      trace("terminal-onData", {
        bytes: data.length,
        preview: JSON.stringify(data.slice(0, 80)),
        compositionActive: compositionPreviewRef.current.active,
      });
      const coreUserInputActive = pendingXtermUserInputOrigins > 0;
      if (coreUserInputActive) pendingXtermUserInputOrigins -= 1;
      const route = routeXtermData({
        writeSource:
          currentParsingAttachEpoch === undefined || currentParsingAttachEpoch === outputAttachEpoch
            ? currentParsingWriteSource
            : "replay",
        humanEventActive: coreUserInputActive || humanDataEmissionDepth > 0,
        userInputOriginReliable,
      });
      if (route === "suppress") return;
      if (route === "human") {
        if (!localTerminalControlAllowed()) return;
        writeToTerminal(instanceId, data).catch(() => {});
        return;
      }
      writeTerminalProtocolReply(instanceId, data).catch(() => {});
    });

    const conptyResizeRepaintFilter = new ConptyResizeRepaintFilter(
      CONPTY_RESIZE_REPAINT_WINDOW_MS,
    );
    const nativeWindowsOutputStabilizer = new NativeWindowsOutputStabilizer();
    const isWindowsHost = navigator.userAgent.includes("Windows");
    let conptyRepaintExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    let outputStabilizerDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stabilizedRefreshFrame: number | undefined;
    let writeTerminalDisplayData: ((data: Uint8Array) => void) | undefined;
    let deliverStabilizedEmissions:
      | ((emissions: StabilizedOutputEmission[], onParsed?: () => void) => void)
      | undefined;
    const pendingStabilizerParsedCallbacks = new DeferredParsedCallbackQueue();
    let normalScrollbackBeforeFit: boolean | undefined;
    let suppressBackendResizeDuringFit = false;
    const clearConptyRepaintExpiryTimer = () => {
      if (conptyRepaintExpiryTimer !== undefined) {
        clearTimeout(conptyRepaintExpiryTimer);
        conptyRepaintExpiryTimer = undefined;
      }
    };
    const scheduleConptyRepaintExpiry = () => {
      clearConptyRepaintExpiryTimer();
      if (!conptyResizeRepaintFilter.isArmed) return;
      conptyRepaintExpiryTimer = setTimeout(
        () => {
          conptyRepaintExpiryTimer = undefined;
          const pending = conptyResizeRepaintFilter.flush();
          if (pending.length > 0) writeTerminalDisplayData?.(pending);
          scheduleConptyRepaintExpiry();
        },
        Math.max(0, conptyResizeRepaintFilter.expiresAt - Date.now()),
      );
    };
    const clearOutputStabilizerDeadlineTimer = () => {
      if (outputStabilizerDeadlineTimer !== undefined) {
        clearTimeout(outputStabilizerDeadlineTimer);
        outputStabilizerDeadlineTimer = undefined;
      }
    };
    const scheduleOutputStabilizerDeadline = () => {
      clearOutputStabilizerDeadlineTimer();
      const deadline = nativeWindowsOutputStabilizer.deadline;
      if (!stabilizeNativeWindowsOutput || deadline === undefined) return;
      outputStabilizerDeadlineTimer = setTimeout(
        () => {
          outputStabilizerDeadlineTimer = undefined;
          const emissions = nativeWindowsOutputStabilizer.flushExpired(monotonicNow());
          deliverStabilizedEmissions?.(emissions, pendingStabilizerParsedCallbacks.drain());
          scheduleOutputStabilizerDeadline();
        },
        Math.max(0, deadline - monotonicNow()),
      );
    };
    const resetOutputStabilizer = () => {
      clearOutputStabilizerDeadlineTimer();
      nativeWindowsOutputStabilizer.reset();
      pendingStabilizerParsedCallbacks.discard();
      if (stabilizedRefreshFrame !== undefined) {
        cancelAnimationFrame(stabilizedRefreshFrame);
        stabilizedRefreshFrame = undefined;
      }
    };
    const armConptyRepaintFilter = () => {
      const token = conptyResizeRepaintFilter.arm();
      scheduleConptyRepaintExpiry();
      return token;
    };
    const cancelConptyRepaintArm = (token: number) => {
      const pending = conptyResizeRepaintFilter.cancelArm(token);
      if (pending.length > 0) writeTerminalDisplayData?.(pending);
      scheduleConptyRepaintExpiry();
    };
    const resizeBackendTerminal = (cols: number, rows: number, protectConptyRepaint: boolean) => {
      const repaintArm = protectConptyRepaint ? armConptyRepaintFilter() : undefined;
      return resizeTerminal(instanceId, cols, rows).catch((error) => {
        if (repaintArm !== undefined) cancelConptyRepaintArm(repaintArm);
        throw error;
      });
    };
    let previousResizeCols = terminal.cols;
    // Handle terminal resize — notify backend PTY
    terminal.onResize(({ cols, rows }) => {
      const widthChanged = cols !== previousResizeCols;
      previousResizeCols = cols;
      if (!localTerminalControlAllowed()) return;
      if (suppressBackendResizeDuringFit) return;

      const normalBuffer = terminal.buffer.normal;
      const hadNormalScrollback = normalScrollbackBeforeFit ?? normalBuffer.baseY > 0;
      const protectConptyRepaint =
        widthChanged &&
        isWindowsHost &&
        terminal.buffer.active === normalBuffer &&
        hadNormalScrollback;
      resizeBackendTerminal(cols, rows, protectConptyRepaint).catch(() => {});
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
    let pendingTerminalWrites = 0;
    let outputAttachParserBusy = false;
    type TerminalWriteMetadata = {
      source: TerminalWriteSource;
      parkDeadline?: number;
      stabilized?: boolean;
      attachEpoch?: number;
    };
    type DeferredTerminalWrite = TerminalWriteMetadata & {
      data: string | Uint8Array;
      onParsed?: () => void;
      warned: boolean;
    };
    const deferredTerminalWrites: DeferredTerminalWrite[] = [];
    const parsingTerminalWrites: DeferredTerminalWrite[] = [];
    let terminalWriteRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTerminalOutputAt = 0;
    let deferredTerminalFit: TerminalFitRequest | undefined;
    let deferredResizeRequestedAt = 0;
    let deferredResizeQuietTimer: ReturnType<typeof setTimeout> | undefined;
    let remoteResizeSyncInFlight = false;
    let remoteResizeSyncAttempt = 0;
    let remoteResizeSyncTargetRevision = 0;
    let remoteResizeSyncTarget:
      | {
          revision: number;
          cols: number;
          rows: number;
          protectConptyRepaint: boolean;
        }
      | undefined;
    let remoteResizeSyncTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let remoteResizeSyncRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeferredResizeQuietTimer = () => {
      if (deferredResizeQuietTimer !== undefined) {
        clearTimeout(deferredResizeQuietTimer);
        deferredResizeQuietTimer = undefined;
      }
    };
    const clearRemoteResizeSyncTimeout = () => {
      if (remoteResizeSyncTimeoutTimer !== undefined) {
        clearTimeout(remoteResizeSyncTimeoutTimer);
        remoteResizeSyncTimeoutTimer = undefined;
      }
    };
    const clearRemoteResizeSyncRetry = () => {
      if (remoteResizeSyncRetryTimer !== undefined) {
        clearTimeout(remoteResizeSyncRetryTimer);
        remoteResizeSyncRetryTimer = undefined;
      }
    };
    const scheduleRemoteResizeSyncRetry = () => {
      if (cancelled || remoteResizeSyncRetryTimer !== undefined) return;
      remoteResizeSyncRetryTimer = setTimeout(() => {
        remoteResizeSyncRetryTimer = undefined;
        if (cancelled || !remoteReturnResizeDirtyRef.current) return;
        if (!localTerminalControlAllowed()) return;
        guardedTerminalFitRef.current?.({ syncBackendResize: true });
      }, REMOTE_RETURN_RESIZE_RETRY_MS);
    };
    const startRemoteResizeSync = (protectConptyRepaint: boolean) => {
      remoteReturnResizeDirtyRef.current = true;
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (
        !remoteResizeSyncTarget ||
        remoteResizeSyncTarget.cols !== cols ||
        remoteResizeSyncTarget.rows !== rows ||
        remoteResizeSyncTarget.protectConptyRepaint !== protectConptyRepaint
      ) {
        remoteResizeSyncTarget = {
          revision: ++remoteResizeSyncTargetRevision,
          cols,
          rows,
          protectConptyRepaint,
        };
      }
      if (
        cancelled ||
        remoteResizeSyncInFlight ||
        !localTerminalControlAllowed() ||
        cols <= 0 ||
        rows <= 0
      ) {
        return;
      }

      const target = remoteResizeSyncTarget;
      remoteResizeSyncInFlight = true;
      const attempt = ++remoteResizeSyncAttempt;
      const resize = resizeBackendTerminal(target.cols, target.rows, target.protectConptyRepaint);
      clearRemoteResizeSyncTimeout();
      remoteResizeSyncTimeoutTimer = setTimeout(() => {
        if (cancelled || attempt !== remoteResizeSyncAttempt) return;
        remoteResizeSyncTimeoutTimer = undefined;
        remoteResizeSyncInFlight = false;
        scheduleRemoteResizeSyncRetry();
      }, REMOTE_RETURN_RESIZE_TIMEOUT_MS);

      resize.then(
        () => {
          if (cancelled || attempt !== remoteResizeSyncAttempt) return;
          clearRemoteResizeSyncTimeout();
          remoteResizeSyncInFlight = false;
          if (
            localTerminalControlAllowed() &&
            remoteResizeSyncTarget?.revision === target.revision
          ) {
            remoteReturnResizeDirtyRef.current = false;
            remoteResizeSyncTarget = undefined;
            clearRemoteResizeSyncRetry();
          } else {
            scheduleRemoteResizeSyncRetry();
          }
        },
        () => {
          if (cancelled || attempt !== remoteResizeSyncAttempt) return;
          clearRemoteResizeSyncTimeout();
          remoteResizeSyncInFlight = false;
          remoteReturnResizeDirtyRef.current = true;
          scheduleRemoteResizeSyncRetry();
        },
      );
    };
    const rebuildTerminalRenderer = () => {
      try {
        (terminal as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
      } catch {
        /* older xterm builds / mocks may lack this method */
      }
      terminal.refresh(0, terminal.rows - 1);
      bindHelperTextareaEvents();
      scheduleOverlayCaretUpdate();
    };
    const performTerminalFit = (request: TerminalFitRequest) => {
      const normalBuffer = terminal.buffer.normal;
      const hadNormalScrollback = terminal.buffer.active === normalBuffer && normalBuffer.baseY > 0;
      const syncBackendResize = request.syncBackendResize || remoteReturnResizeDirtyRef.current;
      normalScrollbackBeforeFit = hadNormalScrollback;
      suppressBackendResizeDuringFit = syncBackendResize;
      try {
        fitAddon.fit();
      } finally {
        suppressBackendResizeDuringFit = false;
        normalScrollbackBeforeFit = undefined;
      }

      if (syncBackendResize) {
        const protectConptyRepaint =
          isWindowsHost && terminal.buffer.active === normalBuffer && hadNormalScrollback;
        startRemoteResizeSync(protectConptyRepaint);
      }

      if (request.rebuildAtlas || reflowDirtyRef.current) {
        rebuildTerminalRenderer();
        reflowDirtyRef.current = false;
      } else {
        bindHelperTextareaEvents();
        scheduleOverlayCaretUpdate();
      }
    };
    const flushDeferredTerminalFit = () => {
      if (
        cancelled ||
        outputAttachParserBusy ||
        pendingTerminalWrites > 0 ||
        deferredTerminalWrites.length > 0 ||
        !deferredTerminalFit
      ) {
        return;
      }
      const now = Date.now();
      const quietFor = now - lastTerminalOutputAt;
      const deferredFor = now - deferredResizeRequestedAt;
      if (
        isWindowsHost &&
        lastTerminalOutputAt > 0 &&
        quietFor < RESIZE_OUTPUT_QUIET_MS &&
        deferredFor < RESIZE_OUTPUT_MAX_WAIT_MS
      ) {
        clearDeferredResizeQuietTimer();
        deferredResizeQuietTimer = setTimeout(
          () => {
            deferredResizeQuietTimer = undefined;
            flushDeferredTerminalFit();
          },
          Math.min(RESIZE_OUTPUT_QUIET_MS - quietFor, RESIZE_OUTPUT_MAX_WAIT_MS - deferredFor),
        );
        return;
      }
      clearDeferredResizeQuietTimer();
      const request = deferredTerminalFit;
      deferredTerminalFit = undefined;
      deferredResizeRequestedAt = 0;
      performTerminalFit(request);
    };
    const requestGuardedTerminalFit = (request: TerminalFitRequest) => {
      if (isContainerHiddenRef.current) {
        if (request.rebuildAtlas) reflowDirtyRef.current = true;
        if (request.syncBackendResize) remoteReturnResizeDirtyRef.current = true;
        return;
      }
      // xterm's write parser and buffer reflow both mutate the active buffer.
      // ConPTY also emits cursor-addressed repaint chunks for the old width.
      // Merge sticky recovery work while waiting for the queue to drain. On
      // Windows, also wait briefly for old-width ConPTY output, with a bound.
      if (!deferredTerminalFit) deferredResizeRequestedAt = Date.now();
      deferredTerminalFit = {
        rebuildAtlas: deferredTerminalFit?.rebuildAtlas || request.rebuildAtlas,
        syncBackendResize: deferredTerminalFit?.syncBackendResize || request.syncBackendResize,
      };
      flushDeferredTerminalFit();
    };
    guardedTerminalFitRef.current = requestGuardedTerminalFit;
    const isXtermWriteBackpressure = (error: unknown) =>
      error instanceof Error && error.message.includes("write data discarded");
    const clearTerminalWriteRetryTimer = () => {
      if (terminalWriteRetryTimer !== undefined) {
        clearTimeout(terminalWriteRetryTimer);
        terminalWriteRetryTimer = undefined;
      }
    };
    const scheduleDeferredTerminalWriteRetry = () => {
      if (
        cancelled ||
        deferredTerminalWrites.length === 0 ||
        terminalWriteRetryTimer !== undefined
      ) {
        return;
      }
      terminalWriteRetryTimer = setTimeout(() => {
        terminalWriteRetryTimer = undefined;
        flushDeferredTerminalWrites();
      }, TERMINAL_WRITE_RETRY_MS);
    };
    const tryTerminalWrite = (request: DeferredTerminalWrite) => {
      pendingTerminalWrites += 1;
      parsingTerminalWrites.push(request);
      if (parsingTerminalWrites.length === 1) {
        currentParsingWriteSource = request.source;
        currentParsingParkDeadline = request.parkDeadline;
        currentParsingAttachEpoch = request.attachEpoch;
      }
      try {
        terminal.write(request.data, () => {
          pendingTerminalWrites = Math.max(0, pendingTerminalWrites - 1);
          if (parsingTerminalWrites[0] === request) {
            parsingTerminalWrites.shift();
          } else {
            const index = parsingTerminalWrites.indexOf(request);
            if (index >= 0) parsingTerminalWrites.splice(index, 1);
          }
          currentParsingWriteSource = parsingTerminalWrites[0]?.source;
          currentParsingParkDeadline = parsingTerminalWrites[0]?.parkDeadline;
          currentParsingAttachEpoch = parsingTerminalWrites[0]?.attachEpoch;
          try {
            request.onParsed?.();
            if (
              request.stabilized &&
              !cancelled &&
              request.attachEpoch === outputAttachEpoch &&
              terminal.rows > 0
            ) {
              if (isContainerHiddenRef.current) {
                reflowDirtyRef.current = true;
              } else {
                terminal.refresh(0, terminal.rows - 1);
                if (stabilizedRefreshFrame !== undefined) {
                  cancelAnimationFrame(stabilizedRefreshFrame);
                }
                stabilizedRefreshFrame = requestAnimationFrame(() => {
                  stabilizedRefreshFrame = undefined;
                  if (
                    !cancelled &&
                    request.attachEpoch === outputAttachEpoch &&
                    terminal.rows > 0
                  ) {
                    if (isContainerHiddenRef.current) {
                      reflowDirtyRef.current = true;
                    } else {
                      terminal.refresh(0, terminal.rows - 1);
                    }
                  }
                });
              }
            }
          } finally {
            scheduleDeferredTerminalWriteRetry();
            flushDeferredTerminalFit();
          }
        });
        return true;
      } catch (error) {
        pendingTerminalWrites = Math.max(0, pendingTerminalWrites - 1);
        const index = parsingTerminalWrites.indexOf(request);
        if (index >= 0) parsingTerminalWrites.splice(index, 1);
        currentParsingWriteSource = parsingTerminalWrites[0]?.source;
        currentParsingParkDeadline = parsingTerminalWrites[0]?.parkDeadline;
        currentParsingAttachEpoch = parsingTerminalWrites[0]?.attachEpoch;
        if (!request.warned) {
          request.warned = true;
          console.warn("[TerminalView] xterm write failed:", error);
        }
        return !isXtermWriteBackpressure(error);
      }
    };
    function flushDeferredTerminalWrites() {
      if (cancelled) return;
      while (deferredTerminalWrites.length > 0) {
        if (!tryTerminalWrite(deferredTerminalWrites[0])) {
          scheduleDeferredTerminalWriteRetry();
          return;
        }
        deferredTerminalWrites.shift();
      }
      clearTerminalWriteRetryTimer();
      flushDeferredTerminalFit();
    }
    const trackedTerminalWrite = (
      data: string | Uint8Array,
      onParsed?: () => void,
      metadata: TerminalWriteMetadata = { source: "replay" },
    ) => {
      const chunks: Array<string | Uint8Array> = [];
      if (metadata.stabilized) {
        // The stabilizer already bounds this request to 1 MiB. Keep the frame
        // end and exact cursor restore in one xterm write so its parser cannot
        // paint the transient footer cursor between chunk callbacks.
        chunks.push(data);
      } else {
        for (let offset = 0; offset < data.length; offset += TERMINAL_WRITE_CHUNK_SIZE) {
          chunks.push(
            data.slice(offset, offset + TERMINAL_WRITE_CHUNK_SIZE) as string | Uint8Array,
          );
        }
      }
      if (chunks.length === 0) chunks.push(data);
      const queueWasEmpty = deferredTerminalWrites.length === 0;
      chunks.forEach((chunk, index) => {
        deferredTerminalWrites.push({
          data: chunk,
          onParsed: index === chunks.length - 1 ? onParsed : undefined,
          warned: false,
          ...metadata,
        });
      });
      if (queueWasEmpty) flushDeferredTerminalWrites();
    };
    const trackedTerminalWriteAsync = (
      data: string | Uint8Array,
      metadata: TerminalWriteMetadata = { source: "replay" },
    ) => new Promise<void>((resolve) => trackedTerminalWrite(data, resolve, metadata));
    let unlistenOutput: (() => void) | undefined;
    let outputListenerReady: Promise<void> = Promise.resolve();
    let outputAttachRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let outputAttachEpoch = 0;
    let outputAttachInFlight = false;
    let cacheRestorePromise: Promise<string | null> = Promise.resolve(null);
    const outputCoordinator = new TerminalOutputAttachCoordinator();
    let terminalOutputWriteChain = Promise.resolve();
    let inAltScreen = false;
    let recentOutputTail = "";
    // Separate, larger rolling buffer for Claude modal detection only.
    // Claude redraws its modal every spinner tick in alt-screen mode, and
    // one ANSI-heavy frame is ~4 KB. The 1 KB `recentOutputTail` above
    // routinely drops the modal text within a few frames, leaving the
    // permission/response detector blind. 16 KB comfortably keeps the
    // modal visible until the user answers it.
    let claudeDetectionBuffer = "";
    // Smaller buffer for dismissal: when this window no longer contains
    // a `❯` arrow we conclude the modal is truly gone. Sized to ~1-2
    // spinner ticks of post-modal output (modal frames are ~4 KB so
    // anything smaller would dismiss the marker mid-frame; anything
    // larger would leave the marker pinned for several seconds after
    // the user actually answered).
    let claudeDismissalBuffer = "";
    const CLAUDE_DISMISSAL_WINDOW = 4096;
    // Session-limit auto-resume (issue #312). The banner ("You've hit your
    // session limit · resets 1:50pm (Asia/Seoul)") lives in the 16 KB
    // detection buffer and is re-scanned on every chunk, so two guards keep
    // the resume from double-firing:
    //   - `sessionLimitArmedKey` — a timer is already pending for this reset
    //     time; re-detections of the same banner are no-ops.
    //   - `sessionLimitLastFired` — the resume already fired for this reset
    //     time; banner residue still in the buffer right after firing would
    //     otherwise re-arm a timer for the SAME printed time tomorrow.
    let sessionLimitTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionLimitSubmitTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionLimitArmedKey: string | undefined;
    let sessionLimitLastFired: { key: string; at: number } | undefined;
    const SESSION_LIMIT_REFIRE_GUARD_MS = 6 * 60 * 60 * 1000;
    // Claude Code's TUI submits on CR only; \n inserts a soft line break. The
    // CR is sent as a standalone write after the text has landed in the input
    // box so long custom messages still submit reliably.
    const SESSION_LIMIT_SUBMIT_CR_DELAY_MS = 150;
    const processTerminalOutput = (
      data: Uint8Array,
      onParsed?: () => void,
      metadata: TerminalWriteMetadata = { source: "live" },
    ) => {
      if (cancelled) return;
      if (data.length === 0) return;
      lastTerminalOutputAt = Date.now();
      clearDeferredResizeQuietTimer();
      trackedTerminalWrite(
        data,
        () => {
          startSyncOutputMonitor();
          onParsed?.();
        },
        metadata,
      );
      const text = streamDecoder.decode(data, { stream: true });
      const previousOutputTail = recentOutputTail;
      const combinedText = (recentOutputTail + text).slice(-1024);
      recentOutputTail = combinedText;
      const previousClaudeBuffer = claudeDetectionBuffer;
      claudeDetectionBuffer = (claudeDetectionBuffer + text).slice(-16384);
      claudeDismissalBuffer = (claudeDismissalBuffer + text).slice(-CLAUDE_DISMISSAL_WINDOW);

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
      const codexInputPending = detectCodexInputPendingFromOutput(combinedText);
      const codexPromptBecamePending = detectNewCodexInputPendingPrompt(previousOutputTail, text);
      if (
        current?.activity?.type === "running" &&
        codexPromptBecamePending &&
        current.activityMessage !== CODEX_INPUT_PENDING_MARKER
      ) {
        useTerminalStore.getState().updateInstanceInfo(instanceId, {
          activity: { type: "interactiveApp", name: "Codex" },
          activityMessage: CODEX_INPUT_PENDING_MARKER,
        });
        useNotificationStore.getState().addNotification({
          terminalId: instanceId,
          workspaceId: resolveWorkspaceId(instanceId),
          message: "Codex is waiting for your input",
          level: "info",
        });
      } else if (
        current?.activity?.type === "interactiveApp" &&
        current.activity.name === "Codex"
      ) {
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
        } else if (codexInputPending) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: CODEX_INPUT_PENDING_MARKER,
          });
        } else if (nextCodexMessage && current.activityMessage !== nextCodexMessage) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: nextCodexMessage,
          });
        }
      }

      // Claude Code permission / response prompt — mirror of the Codex
      // input-pending wiring above. Without this branch the WSL Claude path
      // shows ⏳ indefinitely while Claude is parked on a y/N modal: the
      // working spinner title is still animating behind the modal, so the
      // working→idle title transition (which fires `task_completed` in
      // `claude_activity.rs`) never runs and no notification is emitted.
      // Detecting the modal directly from the rolling output tail closes
      // that gap.
      if (current?.activity?.type === "interactiveApp" && current.activity.name === "Claude") {
        const claudePromptBecamePending = detectNewClaudeInputPendingPrompt(
          previousClaudeBuffer,
          text,
        );
        if (claudePromptBecamePending && current.activityMessage !== CLAUDE_INPUT_PENDING_MARKER) {
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: CLAUDE_INPUT_PENDING_MARKER,
          });
          useNotificationStore.getState().addNotification({
            terminalId: instanceId,
            workspaceId: resolveWorkspaceId(instanceId),
            message: "Claude is waiting for your input",
            level: "info",
            // The modal needs an actual user response — keep the badge
            // up even if this happens to be the active workspace, so
            // the user can step away and still find the alert later.
            requiresAction: true,
          });
        } else if (
          current.activityMessage === CLAUDE_INPUT_PENDING_MARKER &&
          text.trim() &&
          shouldDismissClaudeInputPendingFromOutput(claudeDismissalBuffer)
        ) {
          // Modal truly gone: either the recent output has no modal arrow,
          // or Claude has returned to the normal `╰─❯ ` input prompt. The
          // latter also contains `❯`, so the dismissal check must distinguish
          // it from an arrowed modal option.
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            activityMessage: undefined,
          });
          // The user has resolved the modal; clear the unread badge
          // for the input-pending alert this terminal raised. The
          // notification record is left in the panel as history but
          // no longer counts as unread.
          const notificationStore = useNotificationStore.getState();
          const pendingIds = notificationStore.notifications
            .filter((n) => n.terminalId === instanceId && n.requiresAction && n.readAt === null)
            .map((n) => n.id);
          if (pendingIds.length > 0) {
            notificationStore.markNotificationsAsRead(pendingIds);
          }
          // Reset the detection buffer so the just-resolved modal's
          // residue cannot re-trigger detection on the next chunk
          // (the 16 KB window still holds the answered modal frame).
          // The next genuine modal will refill the buffer naturally.
          claudeDetectionBuffer = "";
        }

        // Claude Code recap surfacing — mirror of the Codex conversation
        // message dedup above (`nextCodexMessage && current.activityMessage
        // !== nextCodexMessage`). When the user returns to an unfocused
        // session Claude prints `※ recap: … (disable recaps in /config)` into
        // the scrollback; detectClaudeRecapFromOutput pulls the freshest one
        // out of the 16 KB detection buffer (it reuses stripAnsi to undo the
        // alt-screen CUP/CUF wrapping). Surface it through activityMessage so
        // ClaudeActivityHandler.computeStatusMessage renders it on the
        // `bullet` path — the same channel Codex replies flow through. Never
        // overwrite a live input-pending modal: while CLAUDE_INPUT_PENDING_MARKER
        // is set the user must answer the modal, so the recap waits.
        if (current.activityMessage !== CLAUDE_INPUT_PENDING_MARKER) {
          const claudeRecap = detectClaudeRecapFromOutput(claudeDetectionBuffer);
          if (claudeRecap && current.activityMessage !== claudeRecap) {
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              activityMessage: claudeRecap,
            });
          }
        }

        // Session-limit auto-resume (issue #312): when Claude prints the
        // limit banner, schedule a resume message for the reset time plus
        // the configured delay. See the dedupe-state comment above for why
        // the armed/last-fired guards exist.
        const sessionLimit = detectClaudeSessionLimitFromOutput(claudeDetectionBuffer);
        if (sessionLimit) {
          const claudeSettings = useSettingsStore.getState().claude;
          const recentlyFired =
            sessionLimitLastFired !== undefined &&
            sessionLimitLastFired.key === sessionLimit.key &&
            Date.now() - sessionLimitLastFired.at < SESSION_LIMIT_REFIRE_GUARD_MS;
          if (
            claudeSettings.sessionLimitAutoResume &&
            sessionLimitArmedKey !== sessionLimit.key &&
            !recentlyFired
          ) {
            const resumeAt = computeSessionLimitResumeAt(
              sessionLimit,
              Date.now(),
              claudeSettings.sessionLimitResumeDelaySeconds ?? 60,
            );
            sessionLimitArmedKey = sessionLimit.key;
            if (sessionLimitTimer !== undefined) clearTimeout(sessionLimitTimer);
            sessionLimitTimer = setTimeout(() => {
              sessionLimitTimer = undefined;
              sessionLimitArmedKey = undefined;
              sessionLimitLastFired = { key: sessionLimit.key, at: Date.now() };
              // The timer may have been armed hours ago — re-check that the
              // pane is still running Claude before typing into it. If the
              // user exited Claude (or another app took over the pane), the
              // resume text would land in the wrong program.
              const liveInstance = useTerminalStore
                .getState()
                .instances.find((i) => i.id === instanceId);
              const stillClaude =
                liveInstance?.activity?.type === "interactiveApp" &&
                liveInstance.activity.name === "Claude";
              if (!stillClaude) {
                useNotificationStore.getState().addNotification({
                  terminalId: instanceId,
                  workspaceId: resolveWorkspaceId(instanceId),
                  message:
                    "Claude session limit reset — auto-resume skipped (Claude is no longer running in this pane)",
                  level: "warning",
                });
                return;
              }
              const message =
                useSettingsStore.getState().claude.sessionLimitResumeMessage || "go on";
              if (!localTerminalControlAllowed()) return;
              void writeToTerminal(instanceId, message);
              sessionLimitSubmitTimer = setTimeout(() => {
                if (localTerminalControlAllowed()) void writeToTerminal(instanceId, "\r");
              }, SESSION_LIMIT_SUBMIT_CR_DELAY_MS);
              useNotificationStore.getState().addNotification({
                terminalId: instanceId,
                workspaceId: resolveWorkspaceId(instanceId),
                message: `Claude session limit reset — sent "${message}" to resume`,
                level: "success",
              });
            }, resumeAt - Date.now());
            useNotificationStore.getState().addNotification({
              terminalId: instanceId,
              workspaceId: resolveWorkspaceId(instanceId),
              message: `Claude hit its session limit — auto-resume scheduled for ${new Date(
                resumeAt,
              ).toLocaleTimeString()}`,
              level: "warning",
            });
          }
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
        markShellPrompt(true);
      }
      if (text.includes("\x1b]133;B") || text.includes("\x1b]633;B")) {
        const shadowCursor = shadowCursorRef.current;
        shadowCursor.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "B" });
        syncShadowCursorToBuffer();
        shadowCursor.commandStartX = shadowCursor.cursorX;
        shadowCursor.commandStartLine = shadowCursor.cursorAbsY;
        setInputPhase(true);
        markShellPrompt(true);
      }
      // Split C (command started → running) from D (command done → back at prompt):
      // isInputPhase collapses both to "not editing", but ↑/↓ routing needs them apart.
      if (text.includes("\x1b]133;C") || text.includes("\x1b]633;C")) {
        shadowCursorRef.current.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "C" });
        setInputPhase(false);
        markShellPrompt(false);
      }
      if (text.includes("\x1b]133;D") || text.includes("\x1b]633;D")) {
        shadowCursorRef.current.hasPromptBoundary = true;
        trace("chunk-prompt-boundary", { code: "D" });
        setInputPhase(false);
        markShellPrompt(true);
      }

      // Detect alt screen buffer switch (vim, nano, htop, less, etc.)
      // NOTE: this raw-text scan is a *secondary* signal — it can miss
      // sequences split across write-chunk boundaries, so it only sets
      // the coarse flags it needs (isAltBufferActive, input phase).
      // The authoritative alt-buffer transition is the CSI `?1049h`
      // parser hook, which fires synchronously on the same bytes and
      // also performs the park cleanup (`parkPending = false`,
      // `clearParkSettleTimer()`). Don't add cleanup here; extend the
      // CSI handler instead.
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
    };
    deliverStabilizedEmissions = (emissions, onParsed) => {
      if (emissions.length === 0) {
        onParsed?.();
        return;
      }
      emissions.forEach((emission, index) => {
        processTerminalOutput(
          emission.data,
          index === emissions.length - 1 ? onParsed : undefined,
          {
            source: "live",
            stabilized: emission.stabilized,
            parkDeadline: emission.parkDeadline,
            attachEpoch: outputAttachEpoch,
          },
        );
      });
    };
    const processLiveTerminalOutput = (
      data: Uint8Array,
      onParsed?: () => void,
      onDiscard?: () => void,
    ) => {
      if (!stabilizeNativeWindowsOutput) {
        processTerminalOutput(data, onParsed, {
          source: "live",
          attachEpoch: outputAttachEpoch,
        });
        return;
      }
      if (onParsed) pendingStabilizerParsedCallbacks.push(onParsed, onDiscard);
      const emissions = nativeWindowsOutputStabilizer.push(data, monotonicNow());
      const parsed =
        nativeWindowsOutputStabilizer.deadline === undefined
          ? pendingStabilizerParsedCallbacks.drain()
          : undefined;
      deliverStabilizedEmissions?.(emissions, parsed);
      scheduleOutputStabilizerDeadline();
    };
    const setOutputReady = (ready: boolean) => {
      outputProtocolReadyRef.current = ready;
      if (!cancelled) setOutputProtocolReady(ready);
    };
    const scheduleOutputReattach = () => {
      if (cancelled || outputAttachRetryTimer !== undefined) return;
      // Invalidate every continuation belonging to the old snapshot before
      // accepting more listener deltas. The old parser chain may still finish
      // its current xterm write, but the next attach is serialized behind it
      // and starts with reset(), so stale work can never publish readiness.
      outputAttachEpoch += 1;
      outputAttachInFlight = false;
      outputAttachParserBusy = true;
      setOutputReady(false);
      resetOutputStabilizer();
      outputCoordinator.beginAttach();
      outputAttachRetryTimer = setTimeout(() => {
        outputAttachRetryTimer = undefined;
        void startOutputAttach();
      }, TERMINAL_WRITE_RETRY_MS);
    };
    const startOutputAttach = async () => {
      if (cancelled || !terminalSessionReady || outputAttachInFlight) return;
      outputAttachInFlight = true;
      outputAttachParserBusy = true;
      const epoch = ++outputAttachEpoch;
      resetOutputStabilizer();
      const isCurrentAttach = () => !cancelled && epoch === outputAttachEpoch;
      try {
        const [rawAttachment, cached] = await Promise.all([
          attachTerminalOutput(instanceId),
          cacheRestorePromise,
        ]);
        if (!isCurrentAttach()) return;
        const attachment = normalizeTerminalOutputAttachment(rawAttachment);

        terminalOutputWriteChain = terminalOutputWriteChain.then(async () => {
          if (!isCurrentAttach()) return;
          terminal.reset();
          if (cached) {
            await trackedTerminalWriteAsync(cached);
            if (!isCurrentAttach()) return;
            await trackedTerminalWriteAsync("\r\n\x1b[90m--- session restored ---\x1b[0m");
            if (!isCurrentAttach()) return;
            await trackedTerminalWriteAsync("\r\n".repeat(terminal.rows));
            if (!isCurrentAttach()) return;
          }
          if (attachment.snapshot.length > 0) {
            await new Promise<void>((resolve) =>
              processTerminalOutput(attachment.snapshot, resolve, { source: "replay" }),
            );
            if (!isCurrentAttach()) return;
          }

          // Cache/snapshot may contain historic DEC mode changes. Apply the
          // backend's state last, to xterm only, before live sequenced deltas.
          await trackedTerminalWriteAsync(
            attachment.state.modes.bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l",
          );
          if (!isCurrentAttach()) return;
          const buffered = outputCoordinator.completeAttach(attachment);
          if (buffered.kind === "gap") {
            console.warn("[TerminalView] terminal output gap during attach", buffered);
            scheduleOutputReattach();
            return;
          }
          for (let index = 0; index < buffered.chunks.length; index += 1) {
            const chunk = buffered.chunks[index];
            if (index === buffered.chunks.length - 1) {
              await new Promise<void>((resolve) =>
                processLiveTerminalOutput(chunk, resolve, resolve),
              );
            } else {
              processLiveTerminalOutput(chunk);
            }
            if (!isCurrentAttach()) return;
          }
          if (isCurrentAttach()) setOutputReady(true);
        });
        await terminalOutputWriteChain;
      } catch (error) {
        if (!cancelled && epoch === outputAttachEpoch) {
          console.warn("[TerminalView] terminal output attach failed:", error);
          scheduleOutputReattach();
        }
      } finally {
        if (epoch === outputAttachEpoch) {
          outputAttachInFlight = false;
          outputAttachParserBusy = false;
          flushDeferredTerminalFit();
          if (!cancelled && !outputCoordinator.ready) scheduleOutputReattach();
        }
      }
    };

    writeTerminalDisplayData = processLiveTerminalOutput;
    outputListenerReady = onTerminalOutputV2(instanceId, (payload) => {
      if (cancelled) return;
      let result;
      try {
        const delta: TerminalOutputDelta = normalizeTerminalOutputDelta(payload);
        result = outputCoordinator.ingest(delta);
      } catch (error) {
        console.warn("[TerminalView] malformed terminal output delta:", error);
        scheduleOutputReattach();
        return;
      }
      if (result.kind === "gap") {
        console.warn("[TerminalView] terminal output gap", result);
        scheduleOutputReattach();
        return;
      }
      for (const rawData of result.chunks) {
        const data = conptyResizeRepaintFilter.filter(rawData);
        scheduleConptyRepaintExpiry();
        processLiveTerminalOutput(data);
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
        runTerminalPaste(writeStructuredPaste, profile);
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
    // Trailing-debounce handle for container-size reflow (see RESIZE_FIT_DEBOUNCE_MS).
    let resizeFitTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const isNowHidden = width === 0 || height === 0;
      isContainerHiddenRef.current = isNowHidden;
      // A pending debounced fit must never run against a hidden container.
      // WorkspaceArea/PaneGrid hide inactive panes via display:none, firing a
      // 0×0 entry; if a drag just scheduled a fit, fitting on the 0×0 box would
      // push cols/rows=0 through the PTY and garble the pane on return. Cancel
      // the pending fit the moment the container goes hidden (issue #285 P2).
      if (isNowHidden && resizeFitTimer !== undefined) {
        clearTimeout(resizeFitTimer);
        resizeFitTimer = undefined;
      }
      if (isNowHidden) {
        if (deferredTerminalFit?.rebuildAtlas) reflowDirtyRef.current = true;
        if (deferredTerminalFit?.syncBackendResize) {
          remoteReturnResizeDirtyRef.current = true;
        }
        deferredTerminalFit = undefined;
        deferredResizeRequestedAt = 0;
        clearDeferredResizeQuietTimer();
      }
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
          const delay = _reserveWebglInitDelay();
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
          registerTerminalSerializer(paneId, () =>
            serializeAddon.serialize(TERMINAL_OUTPUT_SERIALIZE_OPTIONS),
          );
        }
        registerTerminalSerializer(instanceId, () =>
          serializeAddon.serialize(TERMINAL_OUTPUT_SERIALIZE_OPTIONS),
        );

        // Register buffer inspector for automated reflow verification (issue #285).
        // Exposes xterm's reflowed line model (text + isWrapped) so the
        // Automation API can confirm width-change reflow without screenshots.
        const dumpBuffer = (limit: number) => {
          const buf = terminal.buffer.active;
          const total = buf.length;
          const start = limit > 0 ? Math.max(0, total - limit) : 0;
          const lines: TerminalBufferLine[] = [];
          for (let i = start; i < total; i++) {
            const line = buf.getLine(i);
            if (!line) continue;
            lines.push({
              index: i,
              text: line.translateToString(true),
              isWrapped: line.isWrapped,
            });
          }
          return {
            cols: terminal.cols,
            rows: terminal.rows,
            length: total,
            baseY: buf.baseY,
            lines,
          };
        };
        if (paneId) {
          registerTerminalInspector(paneId, dumpBuffer);
        }
        registerTerminalInspector(instanceId, dumpBuffer);

        const scrollViewport = (lines: number) => {
          terminal.scrollLines(lines);
          const buffer = terminal.buffer.active as { baseY?: number; viewportY?: number };
          const baseY = buffer.baseY ?? 0;
          const viewportY = buffer.viewportY ?? baseY;
          return {
            cols: terminal.cols,
            rows: terminal.rows,
            baseY,
            viewportY,
            isAtBottom: viewportY === baseY,
          };
        };
        if (paneId) {
          registerTerminalScroller(paneId, scrollViewport);
        }
        registerTerminalScroller(instanceId, scrollViewport);

        performTerminalFit({});
        openedRef.current = true;
        // Sync viewport-dependent UI once on mount. onScroll only fires on
        // subsequent viewport moves, so a terminal restored (or reattached)
        // while parked above the scrollback bottom must initialize both the
        // jump button and overlay-caret visibility here.
        refreshViewportPresentation();
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

        cacheRestorePromise =
          shouldRestoreOutput && paneId
            ? loadTerminalOutputCache(paneId)
                .then((cached) =>
                  cancelled || !cached || cached.length === 0 ? null : normalBufferOnly(cached),
                )
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (!msg.startsWith("Cache not found:")) {
                    console.warn(
                      `[TerminalView] Unexpected error restoring cache for ${paneId}:`,
                      err,
                    );
                  }
                  return null;
                })
            : Promise.resolve(null);

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
            viewerStartup ?? startupOverride,
          )
            .then((createdSession) => {
              initialExecutionHost = createdSession.initialExecutionHost ?? "unknown";
              stabilizeNativeWindowsOutput =
                shouldStabilizeInitialExecutionHost(initialExecutionHost);
              terminalSessionReady = true;
              if (cancelled) return;
              useTerminalStore.getState().updateInstanceInfo(instanceId, {
                sessionReady: true,
              });
              settleStartupIfReady();
              outputListenerReady
                .then(() => startOutputAttach())
                .catch((error) => {
                  console.warn("[TerminalView] terminal output listener failed:", error);
                  setOutputReady(false);
                });
            })
            .catch((err) => {
              if (cancelled) return;
              console.error(`[TerminalView] Failed to create session ${instanceId}:`, err);
              trackedTerminalWrite(
                `\r\n\x1b[31mFailed to create terminal session: ${err}\x1b[0m\r\n`,
              );
              settleFailedStartup();
            });
        }
      } else if (sessionCreated && width > 0 && height > 0) {
        const recoveringFromHidden = prevWasHidden;
        const consumeDirty = reflowDirtyRef.current;
        const w = Math.round(width);
        const h = Math.round(height);
        // Skip identical-size callbacks unless we are returning from a
        // display:none hide or a deferred reflow is pending (either still
        // needs an atlas rebuild even if dimensions match the pre-hide
        // values).
        if (!recoveringFromHidden && !consumeDirty && w === prevW && h === prevH) {
          prevWasHidden = isNowHidden;
          isContainerHiddenRef.current = isNowHidden;
          return;
        }
        prevW = w;
        prevH = h;

        if (recoveringFromHidden || consumeDirty) {
          // Hide→show recovery / pending dirty reflow are single, important
          // events — apply now and cancel any in-flight drag debounce so the
          // atlas rebuild is not skipped.
          if (resizeFitTimer !== undefined) {
            clearTimeout(resizeFitTimer);
            resizeFitTimer = undefined;
          }
          const proposedDimensions = fitAddon.proposeDimensions();
          const terminalGridChanged =
            !proposedDimensions ||
            proposedDimensions.cols !== terminal.cols ||
            proposedDimensions.rows !== terminal.rows;
          if (
            recoveringFromHidden &&
            !consumeDirty &&
            !terminalGridChanged &&
            !remoteReturnResizeDirtyRef.current
          ) {
            rebuildTerminalRenderer();
          } else {
            // Remove the stale hidden canvas immediately, but keep the guarded
            // fit: a late ConPTY repaint can still target the previous grid.
            if (recoveringFromHidden) rebuildTerminalRenderer();
            requestGuardedTerminalFit({ rebuildAtlas: true });
          }
        } else {
          // Plain container-size change (e.g. dragging a pane divider): debounce
          // so xterm reflow + the PTY resize happen ONCE after the drag settles,
          // never interleaving with ConPTY's per-resize repaints (issue #285).
          if (resizeFitTimer !== undefined) clearTimeout(resizeFitTimer);
          resizeFitTimer = setTimeout(() => {
            resizeFitTimer = undefined;
            // Re-check at fire time: the container may have gone hidden after
            // this was scheduled (race with the 0×0 cancel above). Skip — the
            // hide→show recovery path re-fits on return (issue #285 P2).
            if (cancelled || isContainerHiddenRef.current) return;
            requestGuardedTerminalFit({});
          }, RESIZE_FIT_DEBOUNCE_MS);
        }
      }
      prevWasHidden = isNowHidden;
      isContainerHiddenRef.current = isNowHidden;
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelled = true;
      outputAttachEpoch += 1;
      outputProtocolReadyRef.current = false;
      if (outputAttachRetryTimer !== undefined) clearTimeout(outputAttachRetryTimer);
      clearConptyRepaintExpiryTimer();
      conptyResizeRepaintFilter.disarm();
      resetOutputStabilizer();
      writeTerminalDisplayData = undefined;
      deliverStabilizedEmissions = undefined;
      if (guardedTerminalFitRef.current === requestGuardedTerminalFit) {
        guardedTerminalFitRef.current = null;
      }
      deferredTerminalFit = undefined;
      deferredResizeRequestedAt = 0;
      clearDeferredResizeQuietTimer();
      deferredTerminalWrites.length = 0;
      parsingTerminalWrites.length = 0;
      currentParsingWriteSource = undefined;
      currentParsingParkDeadline = undefined;
      currentParsingAttachEpoch = undefined;
      clearTerminalWriteRetryTimer();
      remoteResizeSyncAttempt += 1;
      remoteResizeSyncInFlight = false;
      remoteResizeSyncTarget = undefined;
      clearRemoteResizeSyncTimeout();
      clearRemoteResizeSyncRetry();
      if (webglTimer !== undefined) clearTimeout(webglTimer);
      if (resizeFitTimer !== undefined) clearTimeout(resizeFitTimer);
      if (sessionLimitTimer !== undefined) clearTimeout(sessionLimitTimer);
      if (sessionLimitSubmitTimer !== undefined) clearTimeout(sessionLimitSubmitTimer);
      if (terminalReflowFrameRef.current !== null) {
        cancelAnimationFrame(terminalReflowFrameRef.current);
        terminalReflowFrameRef.current = null;
      }
      pendingRendererFitRequestRef.current = null;
      clearTimeout(notifyGateTimer);
      clearParkSettleTimer();
      idleDetector.dispose();
      resizeObserver.disconnect();
      outerContainer?.removeEventListener("contextmenu", handleContextMenu);
      outerEl?.removeEventListener("keydown", handleKeyDown);
      outerEl?.removeEventListener("mousemove", handleMouseMove);
      outerEl?.removeEventListener("pointerdown", handlePointerDown);
      outerEl?.removeEventListener("mousedown", handlePathLinkMouseDown, true);
      window.removeEventListener("mouseup", handlePathLinkMouseUp);
      wrapperEl?.removeEventListener("mousedown", handleModifierLinkClick, true);
      for (const eventName of humanDataEvents) {
        wrapperEl?.removeEventListener(eventName, markHumanDataEmission, true);
      }
      xtermUserInputOriginDisposable?.dispose();
      if (pointerUpWatcher) window.removeEventListener("pointerup", pointerUpWatcher);
      window.removeEventListener("blur", handleAppBlurForFocusOwnership);
      window.removeEventListener("focus", handleAppFocusForFocusOwnership);
      window.removeEventListener("pointerdown", handlePointerDownForFocusOwnership, true);
      focusOwnershipSurface?.removeEventListener("focusout", handleFocusOutForFocusOwnership);
      helperTextarea?.removeEventListener("beforeinput", handleBeforeInputForChord);
      helperTextarea?.removeEventListener("blur", handleBlurForChord);
      if (helperTextarea) detachCandidateGuardListeners(helperTextarea);
      restoreHelperAnchor("unmount");
      // unmount 시 진행 중이던 chord press 를 버린다 — 남겨두면 다음 마운트가
      // 아무 텍스트 삽입이나 삼킬 수 있다.
      osInputSourceChord.reset("unmount");
      // unmount 시 열려 있던 후보 window 도 버린다.
      linuxImeCandidateGuard.reset("unmount");
      // unmount 후 stale helper 로 focus 를 되돌리지 않도록 소유권을 버린다.
      focusOwnership.dispose();
      if (focusOwnershipRef.current === focusOwnership) {
        focusOwnershipRef.current = null;
      }
      compositionController.dispose();
      wrapperEl?.classList.remove("terminal-ime-composition-active");
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
      scrollDisposable?.dispose();
      setSyncOutputCursorVisibility(false);
      if (paneId) {
        unregisterTerminalSerializer(paneId);
        unregisterTerminalInspector(paneId);
        unregisterTerminalScroller(paneId);
      }
      unregisterTerminalSerializer(instanceId);
      unregisterTerminalInspector(instanceId);
      unregisterTerminalScroller(instanceId);
      unlistenOutput?.();
      closeTerminalSession(instanceId).catch(() => {});
      terminal.dispose();
      unregisterInstance(instanceId);
    };
    // syncGroup intentionally excluded: changes (e.g. workspace rename) must NOT
    // destroy/recreate the terminal session. syncGroupRef is used at runtime instead.
    // paneId, lastCwd, viewerStartup: mount-time only, must NOT trigger re-creation.
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

  // Issue #439: cwd 가 바뀌면 GitHub 베이스 URL 을 다시 해석해 ref 에 저장한다.
  // pr-link-provider 가 `#123` 링크를 만들 때 이 값을 동기로 읽는다. cwd 가
  // 없거나 GitHub repo 가 아니면 null → 링크가 생성되지 않는다.
  useEffect(() => {
    // #441: cwd 가 바뀌면 이전 repo 값을 **즉시** 비운다. 조회(UNC/WSL 등)가
    // 느리거나 실패하는 창에서 이전 repo 의 이슈를 여는 것보다, 잠깐 링크가
    // 안 뜨는 편이 안전하다.
    repoBaseRef.current = null;
    if (!cwd) return;
    let cancelled = false;
    resolveGitRemote(cwd)
      .then((base) => {
        if (!cancelled) repoBaseRef.current = base;
      })
      .catch(() => {
        if (!cancelled) repoBaseRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Focus/blur terminal when pane focus state changes (only if terminal is opened)
  useEffect(() => {
    // Issue #530: pane focus 가 다른 pane/워크스페이스로 넘어가면(앱이 비활성인
    // 동안 automation 이 바꾼 경우 포함) 기억해 둔 helper 소유권은 stale 이다.
    // 복귀 시 이 pane 이 focus 를 되찾아오지 않도록 즉시 버린다.
    if (!isFocused) focusOwnershipRef.current?.clear("pane-unfocused");
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
  // CSS cursor layers do not cover the WebGL addon's cursor because it is
  // painted into the main canvas. Include composer mode in the xterm option
  // path as well, so both DOM and WebGL renderers lose the application cursor.
  const nativeCursorHidden =
    inputMode === "composer" || (stabilizeInteractiveCursor && isOverlayCaretActivity(activity));
  const effectiveNativeCursorBlink = nativeCursorHidden ? false : effectiveCursorBlink;
  // Coalesce all reflow requests into a single rAF. Calling fit() +
  // clearTextureAtlas() + refresh() multiple times per tick (or even twice
  // back-to-back) compounds with TUI exit bursts (e.g. Codex's `ESC[?1049l`,
  // scrollback re-emit) and is what makes the WebGL atlas race manifest as
  // glyph corruption in adjacent panes.
  const runTerminalRendererReflow = (_term: Terminal, syncBackendResize = false) => {
    const pending = pendingRendererFitRequestRef.current;
    pendingRendererFitRequestRef.current = {
      rebuildAtlas: true,
      syncBackendResize: pending?.syncBackendResize || syncBackendResize,
    };
    if (terminalReflowFrameRef.current !== null) return;
    terminalReflowFrameRef.current = requestAnimationFrame(() => {
      terminalReflowFrameRef.current = null;
      const request = pendingRendererFitRequestRef.current;
      pendingRendererFitRequestRef.current = null;
      if (!request) return;
      const guardedFit = guardedTerminalFitRef.current;
      if (guardedFit) {
        guardedFit(request);
      } else {
        if (request.rebuildAtlas) reflowDirtyRef.current = true;
        if (request.syncBackendResize) remoteReturnResizeDirtyRef.current = true;
      }
    });
  };
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let statusRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let listenerRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let statusEventRevision = 0;
    let statusQueryEpoch = 0;

    // A listener must be installed before the initial snapshot can authorize
    // Local control. Until that barrier succeeds, keep the surface fail-closed.
    remoteControlStatusKnownRef.current = false;
    localControlAvailableRef.current = false;
    setLocalControlAvailable(false);

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const stopStatusRetry = () => {
      if (statusRetryTimer !== undefined) {
        clearTimeout(statusRetryTimer);
        statusRetryTimer = undefined;
      }
    };

    const applyRemoteControlStatus = (status: { active: boolean }) => {
      stopStatusRetry();
      const wasActive = remoteControlActiveRef.current;
      remoteControlStatusKnownRef.current = true;
      remoteControlActiveRef.current = status.active;
      localControlAvailableRef.current = !status.active;
      setLocalControlAvailable(!status.active);
      const term = terminalRef.current;
      if (term) term.options.disableStdin = status.active;
      if (status.active) {
        if (pollTimer === undefined) {
          pollTimer = setInterval(() => {
            void refreshRemoteControlStatus();
          }, REMOTE_CONTROL_STATUS_POLL_MS);
        }
        return;
      }
      stopPolling();
      if (!wasActive) return;
      if (!term || !openedRef.current) return;
      if (isContainerHiddenRef.current) {
        reflowDirtyRef.current = true;
        remoteReturnResizeDirtyRef.current = true;
        return;
      }
      runTerminalRendererReflow(term, true);
    };

    const scheduleStatusRetry = () => {
      if (cancelled || statusRetryTimer !== undefined) return;
      statusRetryTimer = setTimeout(() => {
        statusRetryTimer = undefined;
        void refreshRemoteControlStatus();
      }, REMOTE_CONTROL_STATUS_POLL_MS);
    };

    async function refreshRemoteControlStatus(): Promise<void> {
      const queryEpoch = ++statusQueryEpoch;
      const eventRevision = statusEventRevision;
      try {
        const status = await getRemoteControlStatus();
        if (cancelled || queryEpoch !== statusQueryEpoch || eventRevision !== statusEventRevision) {
          return;
        }
        applyRemoteControlStatus(status);
      } catch {
        if (cancelled || queryEpoch !== statusQueryEpoch || eventRevision !== statusEventRevision) {
          return;
        }
        // Never turn an unknown owner into Local on an IPC failure. Active
        // status keeps its regular polling; the initial unknown state retries.
        if (!remoteControlStatusKnownRef.current) scheduleStatusRetry();
      }
    }

    const handleRemoteControlChanged = (status: { active: boolean }) => {
      if (cancelled) return;
      statusEventRevision += 1;
      statusQueryEpoch += 1;
      applyRemoteControlStatus(status);
    };

    const scheduleListenerRetry = () => {
      if (cancelled || listenerRetryTimer !== undefined) return;
      listenerRetryTimer = setTimeout(() => {
        listenerRetryTimer = undefined;
        installRemoteControlListener();
      }, REMOTE_CONTROL_STATUS_POLL_MS);
    };

    function installRemoteControlListener(): void {
      onRemoteControlChanged(handleRemoteControlChanged)
        .then((cleanup) => {
          if (cancelled) {
            cleanup();
            return;
          }
          unlisten = cleanup;
          void refreshRemoteControlStatus();
        })
        .catch(() => {
          if (cancelled) return;
          remoteControlStatusKnownRef.current = false;
          localControlAvailableRef.current = false;
          setLocalControlAvailable(false);
          const term = terminalRef.current;
          if (term) term.options.disableStdin = true;
          scheduleListenerRetry();
        });
    }

    installRemoteControlListener();

    return () => {
      cancelled = true;
      statusQueryEpoch += 1;
      stopPolling();
      stopStatusRetry();
      if (listenerRetryTimer !== undefined) clearTimeout(listenerRetryTimer);
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    overlayCaretUpdaterRef.current?.();
  }, [activity, isFocused, font, cursorShape, stabilizeInteractiveCursor]);
  useEffect(() => {
    const layoutChanged = lastComposerLayoutModeRef.current !== inputMode;
    lastComposerLayoutModeRef.current = inputMode;
    const frame = requestAnimationFrame(() => {
      const term = terminalRef.current;
      if (inputMode === "composer") {
        term?.blur();
        if (isFocused) composerTextareaRef.current?.focus();
      } else if (isFocused && term && openedRef.current) {
        term.focus();
      }
      if (layoutChanged) {
        if (isContainerHiddenRef.current) {
          reflowDirtyRef.current = true;
        } else {
          guardedTerminalFitRef.current?.({});
        }
      }
      overlayCaretUpdaterRef.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [inputMode, isFocused, localControlAvailable]);
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
      term.options.cursorInactiveStyle = inputMode === "composer" ? "none" : "outline";
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
    inputMode,
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
    // Inactive workspaces are display:none (0×0). Calling fit() here would
    // propagate cols/rows=0 to the PTY and the atlas rebuild is a no-op on
    // an unpainted canvas. Defer to the hidden→visible ResizeObserver path.
    if (isContainerHiddenRef.current) {
      reflowDirtyRef.current = true;
      return;
    }
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
      // Same rationale as the font effect: a DPR change that fires on a
      // hidden (0×0) terminal cannot rebuild anything useful, and fit()
      // would mis-resize the PTY. Defer to the hidden→visible transition.
      if (isContainerHiddenRef.current) {
        reflowDirtyRef.current = true;
      } else {
        try {
          runTerminalRendererReflow(term);
        } catch {
          /* addon/renderer may not be active yet */
        }
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
  const scrollbarStyleForEffect = useSettingsStore((s) => s.terminal.scrollbarStyle ?? "overlay");
  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.options) return;
    try {
      const newWidth = scrollbarStyleForEffect === "overlay" ? 0 : SCROLLBAR_SEPARATE_GUTTER_PX;
      term.options.overviewRuler = { width: newWidth };
      // The overviewRuler option update is harmless while hidden, but
      // fit() on a 0×0 container would PTY-resize to cols=0. Defer.
      if (isContainerHiddenRef.current) {
        reflowDirtyRef.current = true;
      } else {
        guardedTerminalFitRef.current?.({});
      }
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
  const scrollbarStyle = useSettingsStore((s) => s.terminal.scrollbarStyle ?? "overlay");
  const scrollbarClass = scrollbarStyle === "overlay" ? "scrollbar-overlay" : "scrollbar-separate";

  // Issue #361: the jump-to-bottom button is opt-out via settings (default on).
  const showScrollToBottomButtonSetting = useSettingsStore(
    (s) => s.terminal.showScrollToBottomButton ?? true,
  );

  // Issue #504: Tab-triggered Composer past-input recall popup is opt-out (default on).
  const composerHistoryPopupEnabled = useSettingsStore(
    (s) => s.terminal.composerHistoryPopup ?? true,
  );

  // ADR-0055: which terminals share one past-input bucket. Reactive so switching
  // the setting re-renders the list from the newly selected bucket.
  const composerHistoryScope = useSettingsStore(
    (s) => s.terminal.composerHistoryScope ?? DEFAULT_COMPOSER_HISTORY_SCOPE,
  );
  const composerHistoryKey = composerHistoryScopeKey(composerHistoryScope, {
    terminalId: instanceId,
    workspaceId: composerHistoryScope === "workspace" ? resolveWorkspaceId(instanceId) : undefined,
  });
  // Switching buckets invalidates an in-progress edge ↑/↓ walk (its index points
  // into the old list). The popup/autocomplete reset lives in the composer.
  useEffect(() => {
    historyNavRef.current = { index: null, stash: "" };
  }, [composerHistoryKey]);

  // Issue #505: as-you-type Composer autocomplete is opt-out (default on).
  const composerAutocompleteEnabled = useSettingsStore(
    (s) => s.terminal.composerAutocomplete ?? true,
  );

  // Issue #361: the jump-to-bottom button must clear the scrollbar slider so
  // they do not overlap. The slider renders at the same right-edge width in both
  // overlay and separate modes, and the button is positioned relative to the
  // pane edge, so the offset is mode-independent (see SCROLL_BTN_RIGHT_PX).
  const scrollBtnRight = SCROLL_BTN_RIGHT_PX;

  const wrapperStyle: CSSProperties & {
    "--terminal-overlay-caret-color": string;
    "--terminal-foreground-color": string;
    "--terminal-background-color": string;
    "--terminal-scroll-btn-right": string;
  } = {
    "--terminal-overlay-caret-color": overlayCaretColor,
    "--terminal-foreground-color": termFg,
    "--terminal-background-color": termBg,
    "--terminal-scroll-btn-right": `${scrollBtnRight}px`,
    background: termBg,
    padding: `${pt}px ${pr}px ${pb}px ${pl}px`,
  };

  return (
    <div
      className="terminal-surface flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
      style={{ background: termBg }}
      onKeyDownCapture={(event) => {
        if (!matchesKeybinding(event, "terminal.toggleInputMode")) return;
        event.preventDefault();
        event.stopPropagation();
        changeInputMode(inputMode === "direct" ? "composer" : "direct");
      }}
    >
      <div
        ref={wrapperRef}
        data-testid={`terminal-view-${instanceId}`}
        className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${scrollbarClass} ${nativeCursorHidden ? "terminal-native-cursor-hidden" : ""} ${inputMode === "composer" ? "terminal-composer-active" : ""}`}
        style={wrapperStyle}
        onFocusCapture={(event) => {
          if (
            inputMode === "composer" &&
            (event.target as HTMLElement).closest(".xterm-helper-textarea")
          ) {
            requestAnimationFrame(() => composerTextareaRef.current?.focus());
          }
        }}
        onPasteCapture={(event) => {
          if (inputMode !== "direct") return;
          const text = event.clipboardData.getData("text/plain");
          event.preventDefault();
          event.stopPropagation();
          if (text) writeStructuredPaste(text);
        }}
      >
        <div
          data-testid={`terminal-background-${instanceId}`}
          className="terminal-background-layer"
          aria-hidden
        >
          <div className="terminal-loading-spinner" />
        </div>
        <div
          ref={containerRef}
          data-testid={`terminal-xterm-host-${instanceId}`}
          className="terminal-xterm-host"
        />
        <div
          ref={compositionPreviewRefEl}
          data-testid={`terminal-composition-preview-${instanceId}`}
          className="terminal-composition-preview pointer-events-none absolute"
          style={{
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
        {showScrollToBottom && showScrollToBottomButtonSetting && (
          <button
            type="button"
            data-testid={`terminal-scroll-to-bottom-${instanceId}`}
            className="terminal-scroll-to-bottom"
            title={t("terminal.scrollToBottom")}
            aria-label={t("terminal.scrollToBottom")}
            onClick={() => {
              const term = terminalRef.current;
              if (!term) return;
              term.scrollToBottom();
              setShowScrollToBottom(false);
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="butt"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m5 8.5 7 7 7-7" />
            </svg>
          </button>
        )}
      </div>
      <TerminalInputComposer
        mode={inputMode}
        text={composerDraft.text}
        labels={{
          editor: t("terminal.composerEditor"),
          placeholder: t("terminal.composerPlaceholder"),
          resize: t("terminal.composerResize"),
          history: t("terminal.composerHistory"),
          autocomplete: t("terminal.composerAutocomplete"),
        }}
        textareaRef={composerTextareaRef}
        inFlight={composerDraft.inFlight !== null}
        disabled={!localControlAvailable}
        commitDisabled={!outputProtocolReady}
        autoFocus={isFocused}
        testId={`terminal-input-composer-${instanceId}`}
        atShellPrompt={atShellPrompt}
        historyPopupEnabled={composerHistoryPopupEnabled}
        autocompleteEnabled={composerAutocompleteEnabled}
        history={readComposerHistory(composerHistoryKey)}
        historyScopeKey={composerHistoryKey}
        onTextChange={(text) => {
          // A user edit ends history navigation (recall goes through storeComposerDraft).
          historyNavRef.current.index = null;
          storeComposerDraft(updateComposerDraftText(composerDraftRef.current, text));
        }}
        onSend={submitComposerDraft}
        onKeyPassthrough={passthroughComposerKey}
        isKeyProxyActive={composerKeyProxyActive}
        onProxyPaste={pasteComposerProxy}
        onCompositionCommit={commitComposerComposition}
        onHistory={navigateComposerHistory}
      />
    </div>
  );
}
