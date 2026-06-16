import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createIndentedLinkProvider } from "@/lib/indented-link-provider";
import type { IndentedLineInfo } from "@/lib/indented-link-provider";
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
import { useSettingsStore, defaultProfileDefaults } from "@/stores/settings-store";
import { useOverridesStore, FONT_ZOOM_MIN, FONT_ZOOM_MAX } from "@/stores/overrides-store";
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
  statPath,
  handleLxMessage,
  markClaudeTerminal,
  markCodexTerminal,
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
import { shouldDeferTerminalKeyToIme } from "@/lib/ime-key-policy";
import {
  applyActivityLeftTuiToShadowCursor,
  applyDec2026ResetToShadowCursor,
  applyDec2026SetToShadowCursor,
  applyDectcemHideToShadowCursor,
  applyDectcemShowToShadowCursor,
  applyParkSettleTimeoutToShadowCursor,
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
  unregisterTerminalInspector,
  type TerminalBufferLine,
} from "@/lib/terminal-serialize-registry";
import { usePaneControl } from "@/components/layout/PaneControlContext";

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
function runTerminalPaste(terminal: Terminal, profile: string): void {
  const { paste } = useSettingsStore.getState();
  if (!paste.smart) {
    pasteFromBrowserClipboard(terminal, "plain paste");
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
    i18n.t("terminal.pasteConfirm", { ns: "common", bytes: byteLength.toLocaleString() }),
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
  const { t } = useTranslation("common");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCaretRef = useRef<HTMLDivElement>(null);
  const compositionPreviewRefEl = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalReflowFrameRef = useRef<number | null>(null);
  // Tracks whether the TerminalView's container is currently hidden
  // (display:none → 0×0). WorkspaceArea hides inactive workspaces this way
  // and the font/DPR/scrollbar reflow effects (defined below) consult this
  // ref so they can defer fit()/atlas rebuild instead of running on a 0×0
  // container — which would propagate cols/rows=0 through a PTY resize and
  // leave inactive workspaces with garbled glyphs on next show.
  const isContainerHiddenRef = useRef(false);
  // Marks that a reflow trigger fired while the container was hidden. The
  // ResizeObserver's hidden→visible branch consumes this in addition to
  // `prevWasHidden` so the deferred fit() + atlas rebuild fires exactly
  // once when the workspace becomes visible again.
  const reflowDirtyRef = useRef(false);
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
      // ConPTY backend with buildNumber >= 21376 enables xterm's own buffer
      // reflow so scrollback re-wraps correctly on a width change. The #285
      // scrollback corruption is NOT caused by this value (verified: 21375
      // disables reflow and truncates instead) — its real cause is resize
      // events racing ConPTY repaints, fixed by the debounced fit below.
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
        () => useSettingsStore.getState().paste.linkJoin,
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

      // Skip when already cleared — assigning `textContent` replaces
      // child nodes even when the value is unchanged, and this runs on
      // every rAF paint outside composition.
      if (!compositionPreviewRef.current.active && previewEl.textContent) {
        previewEl.style.opacity = "0";
        previewEl.textContent = "";
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

      const shadowCursor = shadowCursorRef.current;
      const caretOwner = resolveVisualCaretOwner({
        opened: openedRef.current,
        focused: isFocusedRef.current,
        stabilizeInteractiveCursor: stabilizeInteractiveCursorRef.current,
        overlayActivity: isOverlayCaretActivity(activityRef.current),
        syncOutputActive: syncOutputActiveRef.current,
        isAltBufferActive: shadowCursor.isAltBufferActive,
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

    let parkSettleTimer: number | undefined;
    let parkSettleDeferrals = 0;
    const clearParkSettleTimer = () => {
      if (parkSettleTimer !== undefined) {
        clearTimeout(parkSettleTimer);
        parkSettleTimer = undefined;
      }
    };
    // NOTE: each DEC 2026 flush restarts this timer, so a TUI that
    // streams frames at < PARK_SETTLE_TIMEOUT_MS intervals *without*
    // ever parking would keep the overlay frozen indefinitely. Codex
    // parks after every frame (the whole reason this layer exists) and
    // `isOverlayCaretActivity` is Codex-only, so there is no exposure
    // today — revisit if another ratatui TUI joins the overlay set.
    const armParkSettleTimer = () => {
      clearParkSettleTimer();
      parkSettleTimer = window.setTimeout(() => {
        parkSettleTimer = undefined;
        const shadowCursor = shadowCursorRef.current;
        if (!shadowCursor.parkPending) return;
        if (shadowCursor.isDec2026FrameOpen) {
          if (parkSettleDeferrals < PARK_SETTLE_MAX_DEFERRALS) {
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
      }, PARK_SETTLE_TIMEOUT_MS);
    };
    const startParkSettleTimer = () => {
      parkSettleDeferrals = 0;
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
            startParkSettleTimer();
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
      if (readyGenerationRef.current !== terminalGeneration) {
        readyGenerationRef.current = terminalGeneration;
        setReadyGeneration(terminalGeneration);
      }
      scheduleOverlayCaretUpdate();
    });
    // Issue #349: toggle the floating jump-to-bottom button as the viewport
    // moves through the scrollback. xterm fires onScroll on every wheel
    // step / scrollToBottom; reading baseY vs viewportY tells us whether the
    // user is pinned to the live bottom.
    const refreshScrollToBottom = () => {
      setShowScrollToBottom(isTerminalScrolledUp(terminal));
    };
    const scrollDisposable = terminal.onScroll?.(refreshScrollToBottom);
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

    // Handle terminal data (user input) — send to backend PTY
    terminal.onData((data) => {
      trace("terminal-onData", {
        bytes: data.length,
        preview: JSON.stringify(data.slice(0, 80)),
        compositionActive: compositionPreviewRef.current.active,
      });
      scheduleShadowCursorSync();
      writeToTerminal(instanceId, data).catch(() => {});

      // Typing into a terminal is a direct "I'm responding here now" signal —
      // an even stronger dismissal than focus (issue #365). A requiresAction
      // alert that arrives in the active workspace stays put until the user
      // acts; entering via keys/mouse, *or* typing, is that action. We clear
      // with the same granularity as the focus/entry policy (AppLayout / ADR
      // 0010·0012): "workspace" clears the whole workspace, "paneFocus" only
      // this pane, "manual" never auto-clears. Guarded by a cheap unread read
      // so the common no-unread keystroke path does no state write / re-render.
      const notifStore = useNotificationStore.getState();
      const dismissMode = useSettingsStore.getState().notifications.dismiss;
      if (dismissMode === "workspace") {
        const wsId = resolveWorkspaceId(instanceId);
        if (notifStore.getUnreadCount(wsId) > 0) notifStore.markWorkspaceAsRead(wsId);
      } else if (dismissMode === "paneFocus") {
        if (notifStore.hasUnreadForTerminal(instanceId)) notifStore.markTerminalAsRead(instanceId);
      }
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
    onTerminalOutput(instanceId, (data) => {
      if (cancelled) return;
      terminal.write(data, () => {
        startSyncOutputMonitor();
      });
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
              void writeToTerminal(instanceId, message);
              sessionLimitSubmitTimer = setTimeout(() => {
                void writeToTerminal(instanceId, "\r");
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
    // Trailing-debounce handle for container-size reflow (see RESIZE_FIT_DEBOUNCE_MS).
    let resizeFitTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const isNowHidden = width === 0 || height === 0;
      // A pending debounced fit must never run against a hidden container.
      // WorkspaceArea/PaneGrid hide inactive panes via display:none, firing a
      // 0×0 entry; if a drag just scheduled a fit, fitting on the 0×0 box would
      // push cols/rows=0 through the PTY and garble the pane on return. Cancel
      // the pending fit the moment the container goes hidden (issue #285 P2).
      if (isNowHidden && resizeFitTimer !== undefined) {
        clearTimeout(resizeFitTimer);
        resizeFitTimer = undefined;
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

        fitAddon.fit();
        openedRef.current = true;
        // Issue #349: sync the jump-to-bottom button once on mount. onScroll
        // only fires on subsequent viewport moves, so a terminal restored
        // (or reattached) while parked above the scrollback bottom would
        // otherwise show no button until the first scroll event.
        refreshScrollToBottom();
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

        // The actual reflow, factored out so the common drag path can debounce
        // it while one-shot recovery events run promptly.
        const applyFit = () => {
          if (cancelled) return;
          fitAddon.fit();
          if (recoveringFromHidden || consumeDirty) {
            // See `prevWasHidden` / `reflowDirtyRef` definitions: the WebGL
            // atlas can go stale while the container is display:none (a DPR
            // or font change that fires on a 0-size terminal cannot rebuild
            // anything), so re-rasterise on the hide → show transition.
            // Safe no-op without WebGL renderer.
            try {
              (terminal as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
            } catch {
              /* older xterm builds / mocks may lack this method */
            }
            terminal.refresh(0, terminal.rows - 1);
            reflowDirtyRef.current = false;
          }
          bindHelperTextareaEvents();
          scheduleOverlayCaretUpdate();
        };

        if (recoveringFromHidden || consumeDirty) {
          // Hide→show recovery / pending dirty reflow are single, important
          // events — apply now and cancel any in-flight drag debounce so the
          // atlas rebuild is not skipped.
          if (resizeFitTimer !== undefined) {
            clearTimeout(resizeFitTimer);
            resizeFitTimer = undefined;
          }
          applyFit();
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
            applyFit();
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
      if (webglTimer !== undefined) clearTimeout(webglTimer);
      if (resizeFitTimer !== undefined) clearTimeout(resizeFitTimer);
      if (sessionLimitTimer !== undefined) clearTimeout(sessionLimitTimer);
      if (sessionLimitSubmitTimer !== undefined) clearTimeout(sessionLimitSubmitTimer);
      if (terminalReflowFrameRef.current !== null) {
        cancelAnimationFrame(terminalReflowFrameRef.current);
        terminalReflowFrameRef.current = null;
      }
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
      if (pointerUpWatcher) window.removeEventListener("pointerup", pointerUpWatcher);
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
      scrollDisposable?.dispose();
      setSyncOutputCursorVisibility(false);
      if (paneId) {
        unregisterTerminalSerializer(paneId);
        unregisterTerminalInspector(paneId);
      }
      unregisterTerminalSerializer(instanceId);
      unregisterTerminalInspector(instanceId);
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
        fitAddonRef.current?.fit();
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
      ref={wrapperRef}
      data-testid={`terminal-view-${instanceId}`}
      className={`relative h-full w-full ${scrollbarClass} ${nativeCursorHidden ? "terminal-native-cursor-hidden" : ""}`}
      style={wrapperStyle}
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
  );
}
