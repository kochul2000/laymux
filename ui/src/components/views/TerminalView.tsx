import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon } from "@/components/ui/icons";
import i18n from "@/i18n";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createIndentedLinkProvider, readIndentedLine } from "@/lib/indented-link-provider";
import type { IndentedLineInfo } from "@/lib/indented-link-provider";
import { createPrLinkProvider } from "@/lib/pr-link-provider";
import {
  DEFAULT_FAST_SCROLL_SENSITIVITY,
  DEFAULT_SCROLL_SENSITIVITY,
  normalizeScrollSensitivity,
} from "@/lib/scroll-sensitivity";
import { resolveLinkAtCell, isModifierLinkClick } from "@/lib/terminal-link-click";
import { createCodexTranscriptWheelHandler } from "@/lib/codex-transcript-wheel";
import {
  _reserveWebglInitDelay,
  isLinuxHost,
  isTerminalScrolledUp,
  monotonicNow,
  shouldEnableTerminalWebgl,
} from "@/lib/terminal-view-runtime";
import { createPathLinkController, type VerifiedPathSelection } from "@/lib/path-link-provider";
import { pathLinkHintKey } from "@/lib/path-link-os-open";
import { osHandoffConfirmKey } from "@/lib/os-handoff";
import { createPathLinkClickHandlers, PATH_LINK_CLICK_SLOP } from "@/lib/path-link-click";
import { createPathLinkHint } from "@/lib/path-link-hint";
import { createPathLinkPointEvaluator, PATH_LINK_HOVER_DWELL_MS } from "@/lib/path-link-point";
import {
  extractPathCandidatesFromSelection,
  isPathLinkCwdCurrent,
  joinCwdPath,
  decidePathLinkAction,
  mapSelectionCandidateToPathRange,
  pathSelectionLimits,
  resolveOverlappingRanges,
} from "@/lib/path-link-detect";
import { readLineCells } from "@/lib/terminal-cell-map";
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
  writeTerminalBinaryInput,
  writeTerminalBootstrapProtocolReply,
  writeTerminalProtocolReply,
  writeTerminalInput,
  resizeTerminal,
  closeTerminalSession,
  failStopTerminalOutputSurface,
  attachTerminalOutput,
  acknowledgeTerminalOutput,
  resumeTerminalOutput,
  onTerminalOutputV2,
  onTerminalOutputV3,
  onTerminalOutputFailStopped,
  smartPaste,
  clipboardWriteText,
  setTerminalCwdSend,
  setTerminalCwdReceive,
  updateTerminalSyncGroup,
  openExternal,
  openInOs,
  resolveGitRemote,
  statPaths,
  handleLxMessage,
  markClaudeTerminal,
  markCodexTerminal,
  markGrokTerminal,
  type TerminalOutputSurfaceFailStoppedPayload,
} from "@/lib/tauri-api";
import { useRemoteControlStatusSnapshot } from "@/lib/remote-control-status";
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_GROK_COMMAND,
  resolveAgentCommand,
} from "@/lib/agent-command";
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
import { createHelperAnchorKeeper } from "@/lib/ime-anchor-keeper";
import {
  clampAnchorCell,
  computeCellMetrics,
  computeHelperAnchorStyle,
  shouldSyncHelperAnchor,
  type AnchorCell,
} from "@/lib/ime-anchor";
import { createLinuxImeCandidateGuard } from "@/lib/linux-ime-candidate-guard";
import { readPendingCompositionSend } from "@/lib/xterm-pending-composition";
import { installNativeCursorSuppression } from "@/lib/native-cursor-suppression";
import { createOsInputSourceChordGuard } from "@/lib/os-input-source-chord";
import { createDirectInputCapture, normalizeSubmittedInput } from "@/lib/terminal-last-input";
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
  createShadowCursorState,
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
  registerTerminalRenderCheckpointProvider,
  unregisterTerminalRenderCheckpointProvider,
  registerTerminalInspector,
  registerTerminalScroller,
  unregisterTerminalInspector,
  unregisterTerminalScroller,
  type TerminalBufferLine,
} from "@/lib/terminal-serialize-registry";
import { TerminalRenderCheckpointModel } from "@/lib/terminal-render-checkpoint";
import {
  registerAtlasRebuilder,
  unregisterAtlasRebuilder,
  notifyTextureAtlasCleared,
  noteTerminalRendered,
} from "@/lib/webgl-atlas-rebuild";
import {
  normalBufferOnly,
  serializeTerminalOutput,
  terminalRestoreBoundary,
} from "@/lib/terminal-output-cache";
import { usePaneControl } from "@/components/layout/PaneControlContext";
import {
  NativeWindowsOutputStabilizer,
  type StabilizedOutputEmission,
} from "@/lib/native-windows-output-stabilizer";
import { WslInFrameCursorParkRecognizer } from "@/lib/wsl-in-frame-cursor-park-recognizer";
import {
  isBootstrapPrimaryDeviceAttributesReply,
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
import { TerminalOutputStoppedBar } from "@/components/ui/TerminalOutputStoppedBar";
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
  subscribeRuntimeInputMode,
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
  TerminalOutputRepairError,
  type TerminalOutputAppliedSegment,
  type TerminalOutputApplyResult,
  type TerminalOutputDelta,
} from "@/lib/terminal-output-attach-coordinator";
import {
  recordTerminalOutputRecovery,
  type TerminalOutputRecoveryEvent,
} from "@/lib/terminal-output-recovery-metrics";
import { coalesceTerminalOutputSegments } from "@/lib/terminal-output-coalesce";
import {
  recordTerminalOutputPipeline,
  type TerminalOutputPipelineCounterName,
} from "@/lib/terminal-output-pipeline-metrics";
import {
  beginTerminalInputDelivery,
  settleTerminalInputDelivery,
} from "@/lib/terminal-input-delivery-metrics";
import {
  TERMINAL_WRITE_BATCH_MAX_BYTES,
  TERMINAL_WRITE_FAIR_QUANTUM_BYTES,
  TerminalWriteBatchQueue,
  terminalWriteFairSlices,
  type PreparedTerminalWriteBatch,
} from "@/lib/terminal-write-batch-queue";
import { TerminalOutputFlowAcknowledger } from "@/lib/terminal-output-flow-control";
import type { TerminalOutputV3Runtime } from "@/lib/terminal-output-v3-runtime";
import { loadTerminalOutputV3Runtime } from "@/lib/terminal-output-v3-runtime-loader";
import { TerminalOutputV3FailureCoordinator } from "@/lib/terminal-output-v3-failure-coordinator";
import {
  TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS,
  TerminalOutputPullWatchdogCadence,
} from "@/lib/terminal-output-pull-watchdog";
import {
  forgetTerminalOutputV3Diagnostics,
  recordTerminalOutputV3Diagnostics,
  registerTerminalOutputV3DiagnosticsProvider,
  type TerminalOutputV3DiagnosticEntry,
} from "@/lib/terminal-output-v3-diagnostics";
import {
  boundedTerminalOutputControlBackoff,
  recoverTerminalOutputControl,
  settleTerminalOutputControl,
} from "@/lib/terminal-output-control-watchdog";
import {
  terminalOutputControlOperationRegistry,
  type TerminalOutputControlOperationKind,
} from "@/lib/terminal-output-control-registry";
import { attemptTerminalWrite } from "@/lib/terminal-write-admission";
import {
  createTerminalWriteFairOwner,
  terminalWriteFairScheduler,
} from "@/lib/terminal-write-fair-scheduler";
import { TerminalParserAdmission, terminalParserPriority } from "@/lib/terminal-parser-admission";

type TerminalWriteCallbackFailureStage =
  | "metrics"
  | "monitor"
  | "consumer"
  | "refresh"
  | "drain"
  | "unknown";

const TERMINAL_WRITE_CALLBACK_STAGE_COUNTER: Record<
  TerminalWriteCallbackFailureStage,
  TerminalOutputPipelineCounterName
> = {
  metrics: "writeCallbackMetricFailures",
  monitor: "writeCallbackMonitorFailures",
  consumer: "writeCallbackConsumerFailures",
  refresh: "writeCallbackRefreshFailures",
  drain: "writeCallbackDrainFailures",
  unknown: "writeCallbackUnknownFailures",
};

const TERMINAL_WRITE_CALLBACK_SOURCE_COUNTER: Record<
  TerminalWriteSource,
  TerminalOutputPipelineCounterName
> = {
  live: "writeCallbackLiveFailures",
  replay: "writeCallbackReplayFailures",
};

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

const REMOTE_RETURN_RESIZE_TIMEOUT_MS = 1000;
const REMOTE_RETURN_RESIZE_RETRY_MS = 100;

const TERMINAL_WRITE_RETRY_MS = 16;

/**
 * How long one `resume_terminal_output` round-trip may stay unsettled before the
 * pane gives up on sequence-exact repair and pays for a full reattach.
 *
 * A repair suspends delta application (`expectedSeq === null`), so a promise
 * that never settles — dead webview↔backend IPC, a collapsed channel — would
 * freeze that pane's output permanently and pile every later delta into the
 * coordinator's `pending`. The round-trip is local IPC (tens of milliseconds
 * even under a 1.2 MB/s flood), so seconds of silence means the channel is gone
 * rather than slow, and the screen-losing reattach is the better outcome than a
 * pane that never prints again (issue #607).
 */
const TERMINAL_OUTPUT_REPAIR_TIMEOUT_MS = 15_000;

/** Local attach/ACK bridge calls should settle far below this on a live WebView. */
const TERMINAL_OUTPUT_CONTROL_TIMEOUT_MS = 5000;

/**
 * How many `resume` round-trips a single hole may take before escalating.
 *
 * A gap that reopens behind an applied repair range is still repayable by
 * another exact range (ADR-0072's "repeated loss during a flood" case), so it is
 * retried rather than escalated. The cap exists only so a stream losing deltas
 * faster than repairs land cannot loop forever (issue #607).
 */
const TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS = 4;

/** Watchdog verdict for a repair round-trip that outran its window. */
const TERMINAL_OUTPUT_REPAIR_TIMED_OUT = Symbol("terminal-output-repair-timed-out");

/**
 * Race a repair round-trip against the watchdog window without leaving a live
 * timer behind when the round-trip wins.
 */
async function withTerminalOutputRepairWatchdog<T>(
  request: Promise<T>,
): Promise<T | typeof TERMINAL_OUTPUT_REPAIR_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<typeof TERMINAL_OUTPUT_REPAIR_TIMED_OUT>((resolve) => {
        timer = setTimeout(
          () => resolve(TERMINAL_OUTPUT_REPAIR_TIMED_OUT),
          TERMINAL_OUTPUT_REPAIR_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Byte-size threshold for the large paste warning dialog. */
const LARGE_PASTE_THRESHOLD = 5120;

/** xterm v6 기본 스크롤바 슬라이더와 FitAddon이 예약하는 거터 폭(px). */
const SCROLLBAR_GUTTER_PX = 14;

/**
 * jump-to-bottom 버튼의 우측 오프셋(px). 버튼은 pane 우측 끝 기준 절대위치이고,
 * xterm 스크롤바 슬라이더는 우측 끝에 약 14px 폭으로 렌더되므로
 * 슬라이더를 비켜가는 단일 값을 쓴다.
 * 14px 슬라이더 + 12px 여유 = 26px (issue #361).
 */
const SCROLL_BTN_RIGHT_PX = SCROLLBAR_GUTTER_PX + 12;

const textEncoder = new TextEncoder();

function markBackendInteractiveTerminal(instanceId: string, activity: TerminalActivityInfo): void {
  if (activity.name === "Claude") {
    markClaudeTerminal(instanceId).catch(() => {});
  } else if (activity.name === "Codex") {
    markCodexTerminal(instanceId).catch(() => {});
  } else if (activity.name === "Grok") {
    markGrokTerminal(instanceId).catch(() => {});
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
const HUMAN_INPUT_DELIVERY_FAILURE_MESSAGE =
  "입력을 터미널에 전달하지 못했습니다. 중복 실행을 막기 위해 자동 재시도하지 않았습니다. 다시 입력하세요.";

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

function getTerminalBaseY(terminal: Terminal): number {
  return (terminal.buffer.active as { baseY?: number }).baseY ?? 0;
}

function getBufferCursorAbsY(terminal: Terminal): number {
  const activeBuffer = terminal.buffer.active as { cursorY?: number };
  return getTerminalBaseY(terminal) + (activeBuffer.cursorY ?? 0);
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
  /** Explicit CWD for a user-requested restart. This overrides restoreCwd settings. */
  restartCwd?: string;
  /** User-requested restart starts a fresh shell instead of restoring session output or Claude. */
  isUserRestart?: boolean;
  /** Called after the first restart session creation settles, so future remounts are normal starts. */
  onUserRestartConsumed?: () => void;
  /** Recreate this pane as a fresh terminal after a typed output fail-stop. */
  onRestart?: () => void;
  /** Claude Code session ID from previous session, used for --resume on startup. */
  lastClaudeSession?: string;
  /** Codex CLI session ID from previous session, used for `codex resume` on startup. */
  lastCodexSession?: string;
  /** Grok Build session ID from previous session, used for `grok --resume` on startup. */
  lastGrokSession?: string;
  /** Override the startup command (takes precedence over agent session restore). */
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
  restartCwd,
  isUserRestart = false,
  onUserRestartConsumed,
  onRestart,
  lastClaudeSession,
  lastCodexSession,
  lastGrokSession,
  startupCommandOverride,
  viewerStartup,
}: TerminalViewProps) {
  const { t } = useTranslation("common");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCaretRef = useRef<HTMLDivElement>(null);
  const compositionPreviewRefEl = useRef<HTMLDivElement>(null);
  const imeFocusRelayRef = useRef<HTMLTextAreaElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // A restart remount may subsequently recreate its session (for example, after
  // a profile change). Only the first session of this component instance is the
  // user-requested fresh start; later recreations retain normal restore policy.
  const firstSessionStartRef = useRef(true);
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
  const remoteControlSnapshot = useRemoteControlStatusSnapshot();
  const remoteControlStatus = remoteControlSnapshot.status;
  const remoteControlReleaseRevisionRef = useRef(remoteControlSnapshot.releaseRevision);
  const remoteControlActiveRef = useRef(false);
  // Until the initial lease status is known, do not let this local surface
  // write or resize the shared PTY. A remote controller may already own it.
  const remoteControlStatusKnownRef = useRef(false);
  const localControlAvailable = remoteControlStatus?.active === false;
  const localControlAvailableRef = useRef(false);
  const outputProtocolReadyRef = useRef(false);
  // Input mode and the composer draft live in a module-level runtime store so a
  // remount keeps them (`terminal-input-composer-state.ts`). `useSyncExternalStore`
  // is how React reads such a store: it owns the subscription, and changing
  // `instanceId` re-subscribes and re-seeds in one step instead of seeding from
  // an effect.
  const inputMode = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => subscribeRuntimeInputMode(instanceId, onStoreChange),
      [instanceId],
    ),
    useCallback(() => readRuntimeInputMode(instanceId), [instanceId]),
  );
  const inputModeRef = useRef(inputMode);
  const lastComposerLayoutModeRef = useRef(inputMode);
  const composerDraftRef = useRef<ComposerDraftState>(readRuntimeComposerDraft(instanceId));
  const composerDraft = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        subscribeRuntimeComposerDraft(instanceId, (draft) => {
          // Mirror synchronously. Handlers that chain edits (history recall, the
          // composition commit) read the ref before React can re-render, so the
          // ref may never lag the store by a tick.
          composerDraftRef.current = draft;
          onStoreChange();
        }),
      [instanceId],
    ),
    useCallback(() => readRuntimeComposerDraft(instanceId), [instanceId]),
  );
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
  // Ref mirrors of render values are committed, never written during render: a
  // concurrent render can be discarded, and a ref written from a discarded
  // render would hand event handlers a value the UI never showed. A layout
  // effect lands at commit time, before any handler or effect can observe it.
  useLayoutEffect(() => {
    currentInstanceIdRef.current = instanceId;
  }, [instanceId]);

  const storeComposerDraft = (next: ComposerDraftState, terminalId = instanceId) => {
    const stored = writeRuntimeComposerDraft(terminalId, next);
    // Handlers that chain edits — history recall, the composition commit — read
    // `composerDraftRef` again before React can re-render, so this pane's ref has
    // to be current the instant the write returns. The store subscription above
    // does mirror synchronously once React has subscribed, which makes this write
    // usually redundant; it stays because the guarantee belongs to the writer, not
    // to whether a subscription happens to be attached (`useSyncExternalStore`
    // subscribes from a passive effect, so the first commit has a window without
    // one). Guarded on the id because callers may target another terminal.
    if (currentInstanceIdRef.current === terminalId) composerDraftRef.current = stored;
  };

  const changeInputMode = (next: InputMode) => {
    // Writing the runtime store notifies this component's own
    // `useSyncExternalStore` subscription, which is what re-renders it. The
    // notification only *schedules* that render, though, and the input-mode
    // listener carries no value (unlike the draft one), so `inputModeRef` would
    // stay stale until the next commit. The toggle handler decides the next mode
    // from `inputModeRef.current`, so it is assigned here for readers that run
    // before the commit lands.
    inputModeRef.current = writeRuntimeInputMode(instanceId, next);
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
        const lastUserInput = normalizeSubmittedInput(started.submission.text);
        if (lastUserInput) {
          useTerminalStore.getState().updateInstanceInfo(started.submission.terminalId, {
            lastUserInput,
            lastUserInputAt: Date.now(),
          });
        }
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
    // Emptiness is deliberately NOT re-derived here. The composer already answered it
    // from the textarea's live value and consumed the event on the strength of that
    // answer; re-asking a ref that can be one edit behind would drop the paste on the
    // floor — written to neither the terminal nor the draft.
    if (!localTerminalControlAllowed()) return;
    const term = terminalRef.current;
    if (!term || term.buffer?.active?.type !== "alternate") return;
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
    // The paste chord is a clipboard gesture, not a key for the app. Forwarding it
    // would send the raw control byte (a fullscreen app shows `^V`) *and* cancel the
    // browser's default action, so the `paste` event that carries the clipboard text
    // would never fire. Leave it alone and let `pasteComposerProxy` route the text.
    if (matchesKeybinding(event, "terminal.paste")) return false;
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

  // Non-render bookkeeping that has to follow `instanceId`. The rendered values
  // are re-seeded by the external-store reads above, so nothing here sets state.
  // `inputModeRef` is deliberately absent: the dependency-free layout effect
  // below mirrors it on *every* commit, and layout effects flush before passive
  // ones in the same commit, so it is already current by the time this runs.
  useEffect(() => {
    historyNavRef.current = { index: null, stash: "" };
    composerDraftRef.current = readRuntimeComposerDraft(instanceId);
    outputProtocolReadyRef.current = false;
  }, [instanceId]);
  // Marks that a reflow trigger fired while the container was hidden. The
  // ResizeObserver's hidden→visible branch consumes this in addition to
  // `prevWasHidden` so the deferred fit() + atlas rebuild fires exactly
  // once when the workspace becomes visible again.
  const reflowDirtyRef = useRef(false);
  const remoteReturnResizeDirtyRef = useRef(false);
  const overlayCaretUpdaterRef = useRef<(() => void) | null>(null);
  // The single owner of "is laymux hiding the native cursor" (issue #598). The
  // condition includes composition state that only the xterm callbacks see, so
  // React never computes it — it pokes this and lets the owner decide.
  const nativeCursorVisibilityRef = useRef<(() => void) | null>(null);
  const openedRef = useRef(false);
  // Each xterm rebuild gets a fresh generation, bumped at render time when
  // (instanceId, profile) changes. A monotonic counter is required because the
  // same (instanceId, profile) pair can be revisited (e.g. PS → WSL → PS quick
  // toggle) and a string key would let the second PS terminal inherit the first
  // one's ready state before its first paint.
  //
  // The counter is React state adjusted during render — the supported way to
  // derive a value from a changed prop (https://react.dev/reference/react/useState
  // "storing information from previous renders"). A ref bumped in the render body
  // would be a render-phase write that a discarded concurrent render could
  // double-count; a ref bumped in an effect would leave the first paint after the
  // switch showing the *old* generation, i.e. a stale "ready" terminal.
  const terminalDepsKey = `${instanceId}:${profile}`;
  const [terminalGenerationState, setTerminalGenerationState] = useState(() => ({
    key: terminalDepsKey,
    generation: 1,
  }));
  const terminalGeneration =
    terminalGenerationState.key === terminalDepsKey
      ? terminalGenerationState.generation
      : terminalGenerationState.generation + 1;
  if (terminalGenerationState.key !== terminalDepsKey) {
    setTerminalGenerationState({ key: terminalDepsKey, generation: terminalGeneration });
  }
  const [readyGeneration, setReadyGeneration] = useState(-1);
  const readyGenerationRef = useRef(-1);
  // Output-protocol readiness records *which xterm generation* published it
  // rather than a bare boolean, so a terminal swap reads as "not ready" by
  // derivation and needs no reset effect (an effect that seeds state is what
  // cascades renders). It has to be the generation, not `instanceId`: a
  // profile-only switch keeps the id, and an A → B → A round trip returns to
  // the same id — both would let the new terminal inherit the previous one's
  // ready state before its first paint, exactly the trap the counter above
  // exists to avoid.
  const [outputProtocolReadyGeneration, setOutputProtocolReadyGeneration] = useState(-1);
  const outputProtocolReady = outputProtocolReadyGeneration === terminalGeneration;
  const [outputFailStop, setOutputFailStop] = useState<{
    generation: number;
    reason: string;
  } | null>(null);
  const outputFailStopReason =
    outputFailStop?.generation === terminalGeneration ? outputFailStop.reason : null;
  // Issue #349: floating "jump to bottom" button. Shown while the user has
  // scrolled up into the scrollback; hidden once pinned to the live bottom.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isReady = readyGeneration === terminalGeneration;
  const isFocusedRef = useRef(isFocused);
  const activityRef = useRef<TerminalActivityInfo | undefined>(undefined);
  const stabilizeInteractiveCursorRef = useRef(true);
  const overlayCursorShapeRef = useRef<"bar" | "underscore" | "filledBox">("bar");
  const onKeyboardActivityRef = useRef(onKeyboardActivity);
  const syncGroupRef = useRef(syncGroup);
  const cwdSendRef = useRef(cwdSend);
  const cwdReceiveRef = useRef(cwdReceive);
  // 리뷰 C: path-link provider 의 getCwd 가 hover(줄)마다 instances.find 로
  // store 배열을 전수 스캔하지 않도록, 이 pane 의 cwd 를 selector 로 한 번
  // 구독해 ref 로 유지한다(syncGroupRef 와 동일 패턴).
  const cwd = useTerminalStore((s) => s.instances.find((i) => i.id === instanceId)?.cwd);
  const cwdRef = useRef(cwd);
  // Latest-value mirrors for the long-lived xterm callbacks, committed rather
  // than written during render (react-hooks/refs). A layout effect runs inside
  // the same synchronous commit, so it lands before any effect, xterm callback
  // or DOM event can read these — the ordering the render-body writes had.
  useLayoutEffect(() => {
    onKeyboardActivityRef.current = onKeyboardActivity;
    isFocusedRef.current = isFocused;
    syncGroupRef.current = syncGroup;
    cwdSendRef.current = cwdSend;
    cwdReceiveRef.current = cwdReceive;
    cwdRef.current = cwd;
    inputModeRef.current = inputMode;
  });
  // Issue #439: pane 의 GitHub 베이스 URL(https://github.com/{owner}/{repo}).
  // cwd 변경 시 백엔드(resolve_git_remote)로 비동기 해석해 ref 에 저장한다.
  // pr-link-provider 는 provideLinks 안에서 이 ref 를 **동기로만** 읽는다
  // (invoke 는 async 이므로 provider 안에서 호출 금지).
  const repoBaseRef = useRef<string | null>(null);
  // Issue #530: 앱 blur 시 실제 DOM focus 를 갖고 있던 helper textarea 의
  // identity 를 기억해, 앱 복귀 다음 프레임에 focus 가 여전히 body/null 일 때만
  // 같은 helper 로 복원한다. 메인 effect 가 생성하고 isFocused effect 도 참조한다.
  const focusOwnershipRef = useRef<TerminalFocusOwnership | null>(null);
  // Issue #363: 선택 기반 path-link 컨트롤러. effect 안에서 채우고
  // pointer release가 확정된 뒤 최종 선택만 검증한다(메인 effect 1회 생성).
  const pathLinkControllerRef = useRef<ReturnType<typeof createPathLinkController> | null>(null);
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
  // Re-seeds the composition scroll baseline (issue #570). Held in a ref because
  // the composition state handler is created before the scroll bookkeeping it
  // has to reset.
  const compositionScrollBaselineRef = useRef<(() => void) | null>(null);
  const compositionPreviewRef = useRef<CompositionPreviewState>({
    active: false,
    text: "",
    caretUtf16Index: 0,
    caretCellOffset: 0,
    textCellWidth: 0,
    anchorBufferX: 0,
    anchorBufferAbsY: 0,
  });
  const shadowCursorRef = useRef<ShadowCursorState>(createShadowCursorState());
  const shouldUseWebgl = shouldEnableTerminalWebgl();

  useEffect(() => {
    let cancelled = false;
    // `instanceId` survives profile-driven effect replacement. The scheduler
    // owner must not: a late callback from the old xterm generation may only
    // cancel/release turns registered by that exact effect lifetime.
    const terminalWriteFairOwner = createTerminalWriteFairOwner(instanceId);
    const terminalParserAdmission = new TerminalParserAdmission(
      terminalWriteFairScheduler,
      terminalWriteFairOwner,
      () => terminalParserPriority(isContainerHiddenRef.current, isFocusedRef.current),
    );
    let terminalSessionReady = false;
    let initialExecutionHost: InitialExecutionHost = "unknown";
    let stabilizeNativeWindowsOutput = false;
    let currentParsingWriteSource: TerminalWriteSource | undefined;
    let currentParsingParkDeadline: number | undefined;
    let currentParsingFrameEndCursorAuthoritative = false;
    let currentParsingAttachEpoch: number | undefined;
    let currentParsingGeneration: number | undefined;
    /** Generation of the attachment the coordinator is currently applying. */
    let outputGeneration: number | undefined;
    let humanDataEmissionDepth = 0;
    let pendingXtermUserInputOrigins = 0;
    let humanInputFailureNotified = false;
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
    // Profile changes recreate the xterm instance under the same focused pane.
    // Registration starts with neutral metadata, so restore the terminal-store
    // projection immediately instead of waiting for a pane focus transition
    // that will never happen when the focused pane index stays unchanged.
    if (isFocusedRef.current) {
      useTerminalStore.getState().setTerminalFocus(instanceId);
    }

    // Diagnostic shadow-cursor tracer. Bound once per effect mount because
    // `instanceId` is constant inside this closure; the tracer is a no-op
    // unless `cursor-trace.ts` gating is on. See `cursor-trace.ts` for how
    // to enable.
    const trace = createCursorTracer(instanceId);
    const notifyHumanInputDeliveryFailure = () => {
      // A repeated IPC outage must remain countable without placing one
      // action-required alert per keystroke in the notification store.
      if (cancelled || humanInputFailureNotified) return;
      humanInputFailureNotified = true;
      useNotificationStore.getState().addNotification({
        terminalId: instanceId,
        workspaceId: resolveWorkspaceId(instanceId),
        message: HUMAN_INPUT_DELIVERY_FAILURE_MESSAGE,
        level: "error",
        requiresAction: true,
      });
    };

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
      // disabled, but blocks keyboard/IME/mouse/focus user input. The layout
      // effect mirrors the current owner snapshot before this passive creation
      // effect, including when the snapshot was already known before mount.
      disableStdin: !localControlAvailableRef.current,
      cursorBlink: resolvedCursorBlink,
      cursorStyle: cursorOptions.cursorStyle,
      cursorInactiveStyle: inputModeRef.current === "composer" ? "none" : "outline",
      ...(cursorOptions.cursorWidth ? { cursorWidth: cursorOptions.cursorWidth } : {}),
      fontSize: resolvedFont.size,
      fontFamily: `'${resolvedFont.face}', 'Cascadia Mono', 'Consolas', monospace`,
      theme,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      // Keep the scrollbar on xterm v6's default 14px gutter while suppressing
      // the overview-ruler canvas and its separator line. FitAddon and the
      // viewport intentionally treat zero as their default scrollbar width.
      overviewRuler: { width: 0 },
      scrollback: 10000,
      scrollSensitivity: normalizeScrollSensitivity(
        settingsState.terminal.scrollSensitivity,
        DEFAULT_SCROLL_SENSITIVITY,
      ),
      fastScrollSensitivity: normalizeScrollSensitivity(
        settingsState.terminal.fastScrollSensitivity,
        DEFAULT_FAST_SCROLL_SENSITIVITY,
      ),
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

    // Rendererless startup is a supported xterm mode: parsing, buffer
    // inspection and serialization do not require terminal.open(). Register
    // these owners before PTY creation so a zero-sized desktop surface still
    // preserves output and can serve Remote/Automation while its DOM renderer
    // waits for usable dimensions (ADR-0161).
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    if (paneId) {
      registerTerminalSerializer(paneId, () => serializeTerminalOutput(terminal, serializeAddon));
    }
    registerTerminalSerializer(instanceId, () => serializeTerminalOutput(terminal, serializeAddon));

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
    if (paneId) registerTerminalInspector(paneId, dumpBuffer);
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
    if (paneId) registerTerminalScroller(paneId, scrollViewport);
    registerTerminalScroller(instanceId, scrollViewport);

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

    // Issue #363: 터미널에서 발견한 파일/디렉토리 경로에 밑줄을 긋고, 클릭하면
    // 파일은 viewer 로 열고 디렉토리는 cwd 로 전파한다. 발견 트리거는 드래그
    // 선택(`selection`)과 포인터 지점(`point`: hover dwell·이동 없는 클릭)이며
    // 후자는 포인터 아래 토큰 하나만 조회한다(ADR-0188). 과거의 "hover 줄 전체
    // 토큰 stat" 을 되살리는 것이 아니다 — 그 방식은 트리거당 조회량이 무제한
    // 이어서 느렸다. 선택 트리거의 검증은 pointer release 의 최종 선택에
    // **gesture당 1회만** 수행하고, 검증되면 데코레이션으로 밑줄을 직접 그린다
    // (xterm linkifier hover 에 의존하면 검증 후 마우스를 나갔다 돌아와야 켜지는
    // 문제가 있어 데코레이션 방식으로 전환 — path-link-provider 주석 참고).
    // #687: 밑줄 위 hover 힌트 라벨. 좌표를 wrapper 기준으로 계산하므로 반드시
    // wrapper 에 붙인다(자식인 xterm host 는 자체 패딩 좌표계라 어긋난다).
    // wrapper 가 아직 없으면 라벨만 생략하고 나머지 경로는 그대로 동작한다.
    const pathLinkHint = createPathLinkHint(wrapperRef.current);
    const pathLink = createPathLinkController(terminal, {
      onOpenPath: (absPath) => {
        useFileViewerStore.getState().openFileViewer(absPath);
      },
      // #687: 호스트 OS 로 위임한다. 확인 대화상자는 이미 mouseup 에서 끝났다.
      // 실패는 spawn 실패뿐이며(그 이후는 OS 소관), 조용히 삼키지 않고 알린다.
      // 모달(alert)이 아니라 알림 스토어를 쓴다 — 모달은 터미널 입력을 막고
      // dev 자동화 루프(스크린샷/Automation)를 세운다.
      onOsAction: (absPath, mode) => {
        openInOs(absPath, mode).catch((err) => {
          console.warn(`[pathLink] ${instanceId} OS ${mode} 실패:`, err);
          useNotificationStore.getState().addNotification({
            terminalId: instanceId,
            workspaceId: resolveWorkspaceId(instanceId),
            message: i18n.t("osHandoff.failed", { ns: "common", message: String(err) }),
            level: "error",
          });
        });
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

    // 검증된 링크를 비우고(있으면) 밑줄 데코레이션을 거둔다. 선택 해제/변경 공통
    // 경로. 새 선택은 point 밑줄도 무효화한다 — 같은 지점에 두 밑줄이 겹치지
    // 않게 하는 ADR-0188 규칙이다.
    const clearPathLinkSelection = () => {
      setPathLinkCursor(false);
      pathLinkHint.hide();
      pathLink.clear();
    };

    // ADR-0188 `point` 트리거. hover dwell 과 이동 없는 클릭이 공유하며, 포인터
    // 아래 maximal token 하나만 조회한다(트리거당 stat_paths 1건). 검증 로직은
    // path-link-point.ts 가 소유하고 여기서는 xterm·스토어·IPC 만 주입한다.
    const pathLinkPoint = createPathLinkPointEvaluator({
      getSettings: () => {
        const terminalSettings = useSettingsStore.getState().terminal;
        return {
          enabled: terminalSettings.pathLinkEnabled,
          maxPathLength: terminalSettings.pathLinkMaxLength,
        };
      },
      getCwd: () => cwdRef.current,
      resolveCell: (clientX, clientY) => {
        const t = terminalRef.current;
        if (!t) return null;
        // getCoords 는 clientX/clientY 와 대상 엘리먼트의 rect 만 읽으므로
        // (xterm `getCoordsRelativeToElement`) 좌표만 담은 객체로 충분하다.
        // 실제 MouseEvent 가 없는 dwell 타이머에서도 같은 변환을 쓰려면 필요하다.
        const coords = getClickCellCoords(t, { clientX, clientY } as MouseEvent);
        if (!coords) return null;
        const [col, viewportRow] = coords;
        const viewportY = t.buffer.active.viewportY ?? 0;
        return { col, absoluteLine: viewportY + viewportRow - 1 };
      },
      readLine: (absoluteLine) => {
        const t = terminalRef.current;
        const line = t?.buffer.active.getLine(absoluteLine);
        return line ? readLineCells(line) : null;
      },
      statPaths,
      isVerifiedAt: (clientX, clientY) => pathLink.getHit(clientX, clientY) !== null,
      apply: (selections) => {
        pathLink.setVerifiedSelections("point", selections);
        // 밑줄이 켜졌으면 포인터는 (dwell 이든 클릭이든) 그 위에 있다. 커서를
        // 먼저 켜 두고, 어긋난 드문 경우는 다음 mousemove 의 hit-test 가 고친다.
        if (selections.length > 0) setPathLinkCursor(true);
      },
    });

    // hover dwell: 포인터가 멈춰 있어야 평가한다. 움직이면 타이머를 다시 잡고,
    // 버튼이 눌린 동안(선택 drag)에는 아예 잡지 않는다(ADR-0165 유지).
    let pathLinkHoverTimer: number | undefined;
    let pathLinkHoverPoint: { x: number; y: number } | null = null;
    const cancelPathLinkHoverDwell = () => {
      if (pathLinkHoverTimer !== undefined) {
        window.clearTimeout(pathLinkHoverTimer);
        pathLinkHoverTimer = undefined;
      }
      pathLinkHoverPoint = null;
    };
    const schedulePathLinkHoverDwell = (event: MouseEvent, overExistingLink: boolean) => {
      // 이미 밑줄 위면 클릭 대상이 있다. 드래그 중에는 조회하지 않는다.
      if (overExistingLink || event.buttons !== 0) {
        cancelPathLinkHoverDwell();
        return;
      }
      // click slop 안의 이동은 "멈춰 있다"로 본다. 매 이동마다 타이머를 다시
      // 잡으면 트랙패드 미세 드리프트로 1px 씩 흔들리는 포인터는 영원히
      // dwell 에 도달하지 못한다.
      const anchor = pathLinkHoverPoint;
      if (
        anchor &&
        pathLinkHoverTimer !== undefined &&
        Math.abs(event.clientX - anchor.x) <= PATH_LINK_CLICK_SLOP &&
        Math.abs(event.clientY - anchor.y) <= PATH_LINK_CLICK_SLOP
      ) {
        return;
      }
      cancelPathLinkHoverDwell();
      pathLinkHoverPoint = { x: event.clientX, y: event.clientY };
      pathLinkHoverTimer = window.setTimeout(() => {
        pathLinkHoverTimer = undefined;
        const point = pathLinkHoverPoint;
        pathLinkHoverPoint = null;
        if (!point) return;
        void pathLinkPoint.evaluateAt(point.x, point.y);
      }, PATH_LINK_HOVER_DWELL_MS);
    };

    // 선택 drag의 mouseup 처리까지 끝난 뒤 1회 호출되는 검증 흐름.
    // 동시 호출/race 를 막기 위해 토큰으로 마지막 요청만 반영한다.
    let pathLinkSelectionSeq = 0;
    const evaluatePathLinkSelection = () => {
      const seq = ++pathLinkSelectionSeq;
      const settings = useSettingsStore.getState().terminal;
      if (!settings.pathLinkEnabled) {
        clearPathLinkSelection();
        return;
      }
      const t = terminalRef.current;
      if (!t) return;
      const selection = t.getSelection();
      const candidates = extractPathCandidatesFromSelection(
        selection,
        pathSelectionLimits(settings.pathLinkMaxLength),
      );
      if (candidates.length === 0) {
        clearPathLinkSelection();
        return;
      }
      const pos = t.getSelectionPosition();
      if (!pos) {
        clearPathLinkSelection();
        return;
      }
      const uniquePaths: string[] = [];
      const pathIndexes = new Map<string, number>();
      const requestedCwd = cwdRef.current;
      const pending = candidates.flatMap((candidate) => {
        const absPath = joinCwdPath(requestedCwd, candidate.text);
        if (!absPath) return [];
        let statIndex = pathIndexes.get(absPath);
        if (statIndex === undefined) {
          statIndex = uniquePaths.length;
          pathIndexes.set(absPath, statIndex);
          uniquePaths.push(absPath);
        }
        const line = t.buffer.active.getLine(pos.start.y + candidate.lineIndex);
        const lineCells = line ? readLineCells(line) : undefined;
        return [
          {
            absPath,
            statIndex,
            token: candidate.text,
            range: mapSelectionCandidateToPathRange(pos, candidate, lineCells),
          },
        ];
      });
      if (pending.length === 0) {
        clearPathLinkSelection();
        return;
      }

      statPaths(uniquePaths)
        .then((infos) => {
          if (seq !== pathLinkSelectionSeq) return; // 더 최신 선택이 있으면 무시.
          if (!isPathLinkCwdCurrent(requestedCwd, cwdRef.current)) {
            clearPathLinkSelection();
            return;
          }
          const existing = pending.flatMap<VerifiedPathSelection>((item) => {
            const info = infos[item.statIndex];
            const action = info ? decidePathLinkAction(info) : "none";
            if (action === "none") return [];
            return [
              {
                ...item.range,
                absPath: item.absPath,
                token: item.token,
                isDirectory: action === "changeDir",
              },
            ];
          });
          // 공백 확장 후보(ADR-0191)는 접두끼리 겹친다 — 존재하는 것 중 같은
          // 줄의 겹치는 범위는 가장 긴 것만 남긴다(longest-existing-wins).
          const verified = resolveOverlappingRanges(existing, (item) => ({
            line: item.bufferLine,
            start: item.startCol,
            end: item.endCol + 1,
          }));
          if (verified.length === 0) {
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
          pathLink.setVerifiedSelections("selection", verified);
        })
        .catch(() => {
          if (seq !== pathLinkSelectionSeq) return;
          clearPathLinkSelection();
        });
    };
    terminalRef.current = terminal;

    // Renderer-level cursor gate (issue #598). Installed once per xterm instance
    // and owned by `applyNativeCursorVisibility` below; see
    // `native-cursor-suppression.ts` for why the option/theme route was wrong.
    const nativeCursorSuppression = installNativeCursorSuppression(terminal);
    if (!nativeCursorSuppression.supported) {
      // Fails open: the native cursor stays visible per the user's settings. The
      // contract test in `native-cursor-suppression.test.ts` is what makes an
      // xterm bump break loudly; this trace is for the running app.
      trace("native-cursor-suppression-unsupported");
    }

    let baseHideNativeCursor = false;
    let syncOutputCursorGateActive = false;
    const applyNativeCursorGate = () => {
      nativeCursorSuppression.setSuppressed(baseHideNativeCursor || syncOutputCursorGateActive);
    };
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
      baseHideNativeCursor = hideNativeCursor;

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
      terminal.options.cursorInactiveStyle = currentInputMode === "composer" ? "none" : "outline";

      // The cursor is switched off at the renderer gate, never disguised as the
      // theme background and never by claiming a shape the app can overwrite
      // (issue #598). Theme and shape therefore stay exactly what the user
      // configured in both branches — the only thing that changes is whether the
      // renderer draws a cursor at all.
      applyNativeCursorGate();
      const cursorOptions = toXtermCursorOptions(resolvedCursorShape);
      terminal.options.theme = resolvedTheme;
      // Blinking a suppressed cursor is pure repaint churn.
      terminal.options.cursorBlink = hideNativeCursor ? false : resolvedCursorBlink;
      terminal.options.cursorStyle = cursorOptions.cursorStyle;
      if (cursorOptions.cursorWidth !== undefined) {
        terminal.options.cursorWidth = cursorOptions.cursorWidth;
      }
      if (cursorOptions.cursorWidth === undefined) {
        delete (terminal.options as { cursorWidth?: number }).cursorWidth;
      }
      // `isCursorHidden` is not an option, so no option-change repaint follows it.
      terminal.refresh(0, terminal.rows - 1);
    };
    nativeCursorVisibilityRef.current = applyNativeCursorVisibility;

    // RenderService buffers normal row requests during DEC 2026, but xterm's DOM
    // focus/blur/selection lifecycle calls renderer.renderRows directly. Keep a
    // separate raw-gate reason for the whole parser frame so those bypasses cannot
    // expose a mid-frame cursor. This reason never changes cursor options and
    // never overwrites the base composer/composition/overlay reason above.
    const setSyncOutputActive = (active: boolean, source: "parser" | "monitor" = "parser") => {
      const wasActive = syncOutputActiveRef.current;
      syncOutputActiveRef.current = active;
      syncOutputCursorGateActive = active;
      applyNativeCursorGate();
      const host = wrapperRef.current;
      if (host) {
        host.classList.toggle("terminal-sync-output-active", active);
      }
      trace("sync-output-visibility", { active });
      overlayCaretUpdaterRef.current?.();
      if (source === "monitor" && wasActive && !active) {
        // xterm's one-second safety timeout lowers the mode and requests a full
        // render without a parser reset. Its debounced render may run before or
        // after this rAF monitor; release the gate and request one recovery paint.
        // The render service coalesces both requests when they meet in one frame.
        terminal.refresh(0, terminal.rows - 1);
      }
    };
    // Installed once the output FIFO is constructed below. A restored multi-part
    // batch is intentionally held while IME composition is active, then resumed
    // from this lifecycle edge without reaching through React state.
    let resumeDeferredTerminalWrites: (() => void) | undefined;
    const compositionController = createImeCompositionController({
      getCols: () => terminal.cols,
      // The cursor the app left after its last settled repaint. Raw buffer cursor,
      // not the shadow: the shadow is frozen for the composition and lags an echo
      // behind (measured on Codex at a wrap — buffer 6, shadow 4 on the same row).
      //
      // Withheld wherever the position is not a settled caret (issue #569):
      //  - a DEC 2026 frame is open, or a save/restore repaint is in flight — the
      //    cursor is parked mid-draw;
      //  - `parkPending`: legacy Codex closes `?2026l` with the cursor still on its footer
      //    and sends the real park ~15ms later in the next chunk, so the position
      //    right after the flush is the footer row, not the input caret;
      //  - the alt buffer, whose rows are a different coordinate space than the
      //    scrollback-relative anchor, and sync-output, which is a repaint by
      //    another name.
      getSettledCursor: () => {
        const shadow = shadowCursorRef.current;
        if (
          shadow.isDec2026FrameOpen ||
          shadow.isRepaintInProgress ||
          shadow.parkPending ||
          shadow.isAltBufferActive ||
          syncOutputActiveRef.current
        ) {
          return null;
        }
        return {
          cursorX: (terminal.buffer.active as { cursorX?: number }).cursorX ?? 0,
          cursorAbsY: getBufferCursorAbsY(terminal),
        };
      },
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
        const byteLength = textEncoder.encode(text).length;
        const attempt = beginTerminalInputDelivery(instanceId, byteLength);
        void writeToTerminal(instanceId, text).then(
          () => settleTerminalInputDelivery(attempt, "succeeded"),
          (error: unknown) => {
            if (!settleTerminalInputDelivery(attempt, "failed") || cancelled) return;
            trace("ime-composition-commit-on-blur-failed", {
              bytes: byteLength,
              error: error instanceof Error ? error.name : "unknown",
            });
            notifyHumanInputDeliveryFailure();
          },
        );
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
        // A composition just opened: start counting scroll from here, so a
        // `baseY` jump that happened while nothing was composing (a reflow moves
        // it without any scroll event) is not charged to this anchor.
        if (!wasActive && state.active) compositionScrollBaselineRef.current?.();
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
          resumeDeferredTerminalWrites?.();
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
    // 조합 lifecycle 은 xterm 의 CompositionHelper 가 계속 소유한다. 여기서는
    // 관찰만 하고 조합 문자열·commit 경로는 건드리지 않는다.
    const attachCandidateGuardListeners = (target: HTMLTextAreaElement) => {
      target.addEventListener("compositionstart", handleCompositionStartForCandidate);
      target.addEventListener("compositionupdate", handleCompositionUpdateForCandidate);
      target.addEventListener("compositionend", handleCompositionEndForCandidate);
      target.addEventListener("input", handleInputForCandidate);
      target.addEventListener("blur", handleBlurForCandidate);
    };
    const detachCandidateGuardListeners = (target: HTMLTextAreaElement) => {
      target.removeEventListener("compositionstart", handleCompositionStartForCandidate);
      target.removeEventListener("compositionupdate", handleCompositionUpdateForCandidate);
      target.removeEventListener("compositionend", handleCompositionEndForCandidate);
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
      if (!openedRef.current || !isFocusedRef.current) {
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
      const compositionPreview = compositionPreviewRef.current;
      const caretOwner = resolveVisualCaretOwner({
        opened: openedRef.current,
        focused: isFocusedRef.current,
        stabilizeInteractiveCursor: stabilizeInteractiveCursorRef.current,
        overlayActivity: isOverlayCaretActivity(activityRef.current),
        syncOutputActive: syncOutputActiveRef.current,
        isAltBufferActive: shadowCursor.isAltBufferActive,
        viewportScrolledUp: isTerminalScrolledUp(term),
        compositionActive: compositionPreview.active,
        cursorHidden: shadowCursor.isCursorHidden,
        hasSyncFramePosition: shadowCursor.hasSyncFramePosition,
        hasPromptBoundary: shadowCursor.hasPromptBoundary,
        isInputPhase: shadowCursor.isInputPhase,
      });

      // A completed composition is no longer part of the visible input surface.
      // Clear it before synchronized-output or post-frame caret freezing can return
      // early; otherwise the committed syllable remains over a newer xterm input row.
      if (!compositionPreview.active) {
        previewEl.style.opacity = "0";
        if (previewEl.childElementCount > 0) {
          previewEl.replaceChildren();
        }
        restoreHelperAnchor("composition-inactive");
      }
      if (caretOwner === "frozen") {
        // DEC 2026 keeps the previously rendered xterm surface visible while
        // parser state advances. Preserve the last non-composition caret opacity
        // and geometry until the frame closes. Live composition outranks this
        // owner and a finished preview was already cleared above.
        trace("overlay-frozen", { reason: "sync-output-active" });
        return;
      }
      if (caretOwner === "alt-buffer" || caretOwner === "hidden") {
        hideOverlay();
        trace("overlay-hidden", { reason: caretOwner, shadowCursor });
        return;
      }

      // Post-frame settle window: the shadow position right after a DEC
      // 2026 flush is only a fallback estimate (Codex's authoritative
      // cursor park arrives ~15 ms later as `?25l` CUP `?25h`). Keep
      // the overlay at its previous painted position instead of
      // repainting with an estimate that may sit on the footer row.
      // Composition preview and sustained DECTCEM hide bypass the
      // freeze — see `shouldFreezeOverlayForPark` for why each must
      // reach paint immediately.
      if (shouldFreezeOverlayForPark(shadowCursorRef.current, compositionPreview.active)) {
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
      setSyncOutputActive(active, "monitor");
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
        setSyncOutputActive(false, "monitor");
        stopSyncOutputMonitor();
        return;
      }
      if (syncOutputMonitorFrame === undefined) {
        setSyncOutputActive(true, "monitor");
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
    // today. Codex 0.145's authoritative in-frame park never enters this
    // pending state — revisit if another ratatui TUI joins the overlay set.
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
          setSyncOutputActive(true);
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
          setSyncOutputActive(false);
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
              currentParsingFrameEndCursorAuthoritative,
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
            if (shadowCursorRef.current.parkPending) {
              startParkSettleTimer(currentParsingParkDeadline);
            } else {
              // Codex 0.145 parks inside the frame, so there is no follow-up
              // chunk to await and no prior settle timer may survive it.
              clearParkSettleTimer();
            }
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
      // ADR-0188: 화면 재출력은 밑줄 아래 텍스트를 바꿀 수 있다. 남아 있는
      // 링크의 원문을 다시 확인해 어긋난 것만 거둔다(항목이 없으면 즉시 반환).
      const droppedPathLinks = pathLink.revalidate();
      // 출력이 왔으면 이전 음성 결과("여긴 파일 아님")도 더 이상 못 믿는다 —
      // memo 만 잊고 진행 중 조회는 살린다. 여기서 revision 까지 올리면 출력이
      // 잦은 pane 에서 hover 결과가 매번 폐기돼 밑줄이 영원히 안 켜진다.
      pathLinkPoint.forget();
      if (droppedPathLinks > 0) setPathLinkCursor(false);
      if (compositionPreviewRef.current.active) {
        // The shadow cursor stays frozen for the composition, but the *text* the
        // app just echoed is a fact, and it is the only thing that knows where an
        // app-owned input box actually put it (issue #569).
        compositionController.notifyEchoLanded();
        return;
      }
      scheduleShadowCursorSync();
    });
    const renderDisposable = terminal.onRender(() => {
      // A paint refills the render model with coordinates into the current
      // atlas, so a foreign clear from here on has to reach this terminal even
      // if the fan-out already visited it this frame (issue #573).
      noteTerminalRendered(instanceId);
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
    // An open composition's anchor is an absolute row, and the preview's screen
    // position subtracts `baseY` from it. A TUI that keeps its input box at the
    // bottom grows `baseY` as it prints, so a stationary anchor drifts upward by
    // exactly the rows emitted (issue #570). Carry it along; nothing else
    // re-anchors between composition events.
    //
    // The baseline is re-seeded whenever a composition opens rather than kept
    // running. `baseY` also moves without an `onScroll`: a cols change reflows
    // the scrollback and can shift `ybase` by hundreds of rows, and only
    // `onResize` fires. Carrying a stale baseline into the next composition
    // would dump that whole jump into its first scroll.
    let lastCompositionBaseY = getTerminalBaseY(terminal);
    let lastCompositionBufferType = terminal.buffer.active.type;
    const seedCompositionScrollBaseline = () => {
      lastCompositionBaseY = getTerminalBaseY(terminal);
      lastCompositionBufferType = terminal.buffer.active.type;
    };
    compositionScrollBaselineRef.current = seedCompositionScrollBaseline;
    /**
     * The single owner of "what a `baseY` move owes an open composition".
     *
     * Called from `onScroll` for live scrolls and once more when a buffer rebuild
     * closes, which is why the shadow-cursor carry is a parameter rather than
     * unconditional (see `withCompositionScrollRebuild`).
     */
    const chargeCompositionBaseYMove = (options: { carryShadowCursor: boolean }) => {
      const bufferType = terminal.buffer.active.type;
      const baseY = getTerminalBaseY(terminal);
      // xterm forwards buffer activation and `clear()` through the same scroll
      // event, and those move `baseY` by its whole value without moving the
      // input line by that much. Re-seed instead of reporting a scroll.
      if (bufferType !== lastCompositionBufferType) {
        lastCompositionBufferType = bufferType;
        lastCompositionBaseY = baseY;
        return;
      }
      const rowDelta = baseY - lastCompositionBaseY;
      lastCompositionBaseY = baseY;
      if (rowDelta === 0 || !compositionPreviewRef.current.active) return;
      if (options.carryShadowCursor) {
        // The shadow cursor is frozen for the duration of a composition
        // (`composition-preview-active`), so it holds the input line's row from
        // before the scroll. Move it with the anchor: leaving it behind makes the
        // next carry-over read a row that disagrees with the shifted origin,
        // classify it as `originMoved`, and snap the preview back up.
        shadowCursorRef.current.cursorAbsY += rowDelta;
      }
      compositionController.notifyBufferScrolled(rowDelta);
    };
    // A stream rebuild — `terminal.reset()` plus the snapshot replay serialized
    // behind it — demolishes the buffer's coordinate space and builds a new one.
    // `reset()` emits `onScroll` **synchronously**, with `baseY` already 0
    // (pinned against the shipped bundle in `xterm-semantics.screen.test.ts`),
    // and the replay then grows `baseY` back over many awaited writes.
    //
    // Charging those events to an open composition one at a time hands the anchor
    // the entire scrollback height as a negative jump first and only repays it as
    // the snapshot lands. A Korean syllable composed across that window therefore
    // spends its whole life anchored off the top of the screen (issue #602) — the
    // repayment arrives after it has already committed. Suppressing only the reset
    // would be worse, not better: the replay's growth would then be charged with
    // nothing to offset it.
    //
    // So the whole rebuild is one window. Its `onScroll` events are skipped with
    // the baseline left frozen, and the single charge at the close is measured
    // against that frozen baseline — which is exactly issue #570's rule applied to
    // the rebuild as a unit, and stays right for a composition that opened *inside*
    // the window (its own `compositionstart` re-seeded the baseline).
    let compositionScrollRebuildDepth = 0;
    /**
     * Run a buffer rebuild with composition scroll accounting deferred to its net
     * (issue #602). The `finally` is load-bearing: an abandoned window would leave
     * the baseline frozen and silently stop issue #570's carry-along.
     */
    const withCompositionScrollRebuild = async (rebuild: () => Promise<void>) => {
      compositionScrollRebuildDepth += 1;
      try {
        await rebuild();
      } finally {
        compositionScrollRebuildDepth = Math.max(0, compositionScrollRebuildDepth - 1);
        if (compositionScrollRebuildDepth === 0) {
          // Not `carryShadowCursor`: `resetStreamDerivedCursorState` cleared the
          // shadow inside this window (issue #596), so there is no row left to
          // carry, and adding a delta to the cleared `cursorAbsY` would invent one
          // that later blocks shadow syncs with `row-mismatch`. With the beliefs
          // cleared `computeUseShadowCursor` is false anyway, so the controller
          // reads the live buffer cursor and never compares against the shadow.
          chargeCompositionBaseYMove({ carryShadowCursor: false });
        }
      }
    };
    const scrollDisposable = terminal.onScroll?.(() => {
      // A rebuild owns the composition accounting until it closes, baseline and
      // all. Viewport presentation is unaffected — it reads the live buffer.
      if (compositionScrollRebuildDepth === 0) {
        chargeCompositionBaseYMove({ carryShadowCursor: true });
      }
      refreshViewportPresentation();
      // #687: 밑줄은 마커를 따라 움직이지만 힌트 라벨은 mousemove 에서만 자리를
      // 잡는다. 스크롤 뒤 포인터가 멈춰 있으면 라벨만 옛 좌표에 남으므로 감춘다
      // (다음 mousemove 가 필요하면 다시 그린다).
      pathLinkHint.hide();
    });
    // Issue #530: 앱 비활성화(Alt-Tab 등)에서 webview 가 helper textarea 의 실제
    // DOM focus 를 body/null 로 떨어뜨려도 store 의 pane focus 는 그대로이므로
    // 어떤 effect 도 재실행되지 않는다 → 복귀 후 첫 키/첫 IME 조합이 유실된다.
    // pane focus 를 DOM focus 와 동일시하지 않고, blur 시점에 이 pane 의 helper
    // 가 정말 focus 를 갖고 있었을 때만 identity 를 기억해 복귀 시점의 DOM
    // 상태에 맞는 phase에서 복원한다. 다른 UI(모달·검색·설정·다른 pane)가 focus 를 얻으면
    // 절대 빼앗지 않는다 (ADR-0057).
    const focusOwnership = createTerminalFocusOwnership({
      getContainer: () => wrapperRef.current,
      // The stale DOM-active/native-IME split is a measured WebView2 failure.
      // Linux keeps ADR-0053's no-synthetic-blur policy until equivalent
      // headful evidence exists.
      refreshActiveHelper: navigator.userAgent.includes("Windows"),
      // ADR-0108: unlike a same-element blur/focus pair, a different editable
      // identity reproduces the pane-roundtrip recovery observed in Windows.
      getFocusRelay: () => imeFocusRelayRef.current,
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
    const handleInputForFocusOwnership = (event: Event) => {
      focusOwnership.releaseForHelperInput(event.target);
    };
    const focusOwnershipInputEvents = [
      "keydown",
      "beforeinput",
      "input",
      "compositionstart",
    ] as const;
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
        for (const eventName of focusOwnershipInputEvents) {
          helperTextarea.removeEventListener(eventName, handleInputForFocusOwnership);
        }
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
      for (const eventName of focusOwnershipInputEvents) {
        helperTextarea.addEventListener(eventName, handleInputForFocusOwnership);
      }
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

    terminal.attachCustomWheelEventHandler(
      createCodexTranscriptWheelHandler({
        terminal,
        isEnabled: () => useSettingsStore.getState().codex.transcriptScrollEnabled,
        isCodexActive: () => {
          const activity = useTerminalStore
            .getState()
            .instances.find((instance) => instance.id === instanceId)?.activity;
          return activity?.type === "interactiveApp" && activity.name === "Codex";
        },
        isLocalControlAllowed: localTerminalControlAllowed,
      }),
    );

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
      // 사각형은 한 번만 읽어 hit-test 와 라벨 배치에 함께 쓴다(mousemove 마다
      // 같은 요소를 두 번 재는 강제 리플로우를 피한다).
      const hit = pathLink.getHit(e.clientX, e.clientY);
      const rect = hit?.rect ?? null;
      const inside = hit !== null;
      setPathLinkCursor(inside);
      // #687: 수정자 클릭은 발견성이 없으므로, 밑줄 위에 있을 때만 무엇을 할 수
      // 있는지 라벨로 알린다. 기능이 꺼져 있으면 알릴 것이 없다.
      const sel = hit?.selection ?? null;
      const hintKey = sel
        ? pathLinkHintKey(
            sel.isDirectory,
            useSettingsStore.getState().terminal.pathLinkOsOpenEnabled,
          )
        : null;
      if (rect && hintKey) pathLinkHint.show(rect, i18n.t(hintKey, { ns: "common" }));
      else pathLinkHint.hide();
      // ADR-0188: 포인터가 멈추면 그 지점 하나를 검증한다(밑줄 위면 생략).
      schedulePathLinkHoverDwell(e, inside);
    };
    const handleMouseLeave = () => {
      cancelPathLinkHoverDwell();
      pathLinkHint.hide();
    };
    outerEl?.addEventListener("keydown", handleKeyDown);
    outerEl?.addEventListener("mousemove", handleMouseMove);
    outerEl?.addEventListener("mouseleave", handleMouseLeave);

    // #363: 밑줄(검증된 경로) 클릭으로 열기/이동. 데코레이션은 pointer-events:none
    // 이라 mousedown/up 은 그대로 xterm 으로 흘러가 선택/드래그가 정상 동작한다.
    // 여기서는 관찰만 하여 — 밑줄 위에서 시작한 '클릭'(드래그 아님)이면 캡처한
    // 경로를 연다(파일=viewer, 디렉토리=cwd 전파). 드래그면 무시해 일반 재선택이
    // 되게 두고, 경로는 gesture 완료 뒤 최종 선택으로 새로 평가한다. 클릭 시 xterm 이
    // 선택을 지워 current 가 비므로, 경로는 mousedown 시점에 캡처해 둔다.
    //
    // #687(ADR-0100): Ctrl / Ctrl+Shift 는 호스트 OS 로 위임한다. 이 조합만은
    // "관찰"이 아니라 **소유**한다 — 밑줄 안에서 성립하면 mousedown 을
    // preventDefault + stopImmediatePropagation 으로 종결해, xterm 의 선택 확장,
    // TUI 로의 마우스 리포팅 전달, #352 우회가 같은 클릭을 함께 처리하지 못하게
    // 한다(#352 쪽은 isModifierLinkClick 이 Ctrl 조합을 배제해 이중 안전).
    // 상태 기계는 path-link-click.ts 가 소유한다(단위 테스트 대상). 여기서는
    // 스토어·i18n·터미널 포커스만 주입해 배선한다.
    const pathLinkClick = createPathLinkClickHandlers<VerifiedPathSelection>({
      getSelectionAt: (x, y) => pathLink.getHit(x, y)?.selection ?? null,
      getSettings: () => {
        const terminalSettings = useSettingsStore.getState().terminal;
        return {
          osOpenEnabled: terminalSettings.pathLinkOsOpenEnabled,
          confirmAlways: terminalSettings.pathLinkOsOpenConfirm,
        };
      },
      confirm: ({ path }) =>
        window.confirm(i18n.t(osHandoffConfirmKey(path), { ns: "common", path })),
      activate: (sel, action) => pathLink.activate(sel, action),
      // mousedown 을 preventDefault 했고 네이티브 대화상자가 포커스를 가져가므로,
      // 진행·취소 어느 쪽이든 터미널 포커스를 되돌려 준다.
      onOsHandoffSettled: () => terminalRef.current?.focus(),
    });
    // capture 단계로 xterm 핸들러보다 먼저 관찰한다. 전파를 막는 것은 위의
    // 호스트 OS 위임 조합뿐이고, 나머지 클릭은 그대로 흘려보낸다. #352 우회
    // 리스너도 같은 wrapper 엘리먼트의 capture 에 등록되므로, 여기서 먼저
    // 등록해 두는 것이 순서상 우선한다(실질 방어는 isModifierLinkClick 의 Ctrl
    // 배제이며, 이 등록 순서는 그 이중 안전이다).
    const handlePathLinkMouseDown = (e: MouseEvent) => pathLinkClick.onMouseDown(e);
    const handlePathLinkMouseUp = (e: MouseEvent) => pathLinkClick.onMouseUp(e);
    outerEl?.addEventListener("mousedown", handlePathLinkMouseDown, true);
    window.addEventListener("mouseup", handlePathLinkMouseUp);

    // xterm finalizes a mouse selection in its document-level `mouseup`
    // listener and only then fires onSelectionChange. Browser compatibility
    // events arrive as pointerup -> mouseup, so pointerup itself is too early
    // to read the final selection. Keep one gesture record and finish from the
    // window mouseup (after document); a zero-delay pointerup fallback covers
    // releases for which xterm/browser never delivers that mouseup (#230).
    let pointerSelectionGesture: {
      pointerId: number;
      startX: number;
      startY: number;
      moved: boolean;
      selectionChanged: boolean;
    } | null = null;
    let pointerSelectionFinalizeTimer: number | undefined;

    const handlePointerSelectionMove = (event: PointerEvent) => {
      const gesture = pointerSelectionGesture;
      if (!gesture || event.pointerId !== gesture.pointerId || gesture.moved) return;
      if (
        Math.abs(event.clientX - gesture.startX) <= PATH_LINK_CLICK_SLOP &&
        Math.abs(event.clientY - gesture.startY) <= PATH_LINK_CLICK_SLOP
      ) {
        return;
      }
      gesture.moved = true;
      // Preserve an existing verified target through mousedown so
      // pathLinkClick can capture it, then retire its decoration as soon as
      // the gesture becomes a drag rather than a click.
      clearPathLinkSelection();
    };

    const removePointerSelectionListeners = () => {
      window.removeEventListener("pointermove", handlePointerSelectionMove);
      window.removeEventListener("pointerup", handlePointerSelectionUp);
      window.removeEventListener("pointercancel", handlePointerSelectionCancel);
      window.removeEventListener("mouseup", handlePointerSelectionMouseUp);
    };
    const retirePointerSelectionGesture = () => {
      const gesture = pointerSelectionGesture;
      pointerSelectionGesture = null;
      removePointerSelectionListeners();
      if (pointerSelectionFinalizeTimer !== undefined) {
        window.clearTimeout(pointerSelectionFinalizeTimer);
        pointerSelectionFinalizeTimer = undefined;
      }
      return gesture;
    };
    const finalizePointerSelection = () => {
      const gesture = retirePointerSelectionGesture();
      if (!gesture) return;
      if (gesture.moved) {
        // 드래그 → 최종 선택을 gesture 당 1회 검증한다(ADR-0165).
        evaluatePathLinkSelection();
      } else {
        // 이동 없는 클릭 → 그 지점 하나를 검증한다(ADR-0188). 밑줄 위 클릭은
        // pathLinkClick 이 이미 열기로 처리했고 evaluator 가 재파싱하지 않는다.
        // 클릭이 선택을 지웠으면 onSelectionChange 가 stale 링크를 이미 거뒀다.
        cancelPathLinkHoverDwell();
        void pathLinkPoint.evaluateAt(gesture.startX, gesture.startY);
      }
      if (useSettingsStore.getState().terminal.copyOnSelect) runTerminalCopy(terminal);
    };
    const handlePointerSelectionUp = (event: PointerEvent) => {
      const gesture = pointerSelectionGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (pointerSelectionFinalizeTimer === undefined) {
        pointerSelectionFinalizeTimer = window.setTimeout(finalizePointerSelection, 0);
      }
    };
    const handlePointerSelectionCancel = (event: PointerEvent) => {
      const gesture = pointerSelectionGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      retirePointerSelectionGesture();
    };
    const handlePointerSelectionMouseUp = () => finalizePointerSelection();

    // Copy-on-select: auto-copy to clipboard when text is selected.
    // `runTerminalCopy` handles the has-selection guard and smart-indent
    // branching, keeping this path in lockstep with Ctrl+C and right-click.
    terminal.onSelectionChange(() => {
      if (useSettingsStore.getState().terminal.copyOnSelect) {
        runTerminalCopy(terminal);
      }
      if (pointerSelectionGesture) pointerSelectionGesture.selectionChanged = true;
      // Issue #363/#ADR-0165: 선택 변경에서는 stale 링크와 진행 중인 검증만
      // 무효화한다. 후보 파싱과 filesystem stat은 gesture 완료 뒤에만 한다.
      // ADR-0188: 새 선택은 point 밑줄과 그 재조회 memo 도 무효화한다.
      pathLinkSelectionSeq += 1;
      pathLinkPoint.invalidate();
      clearPathLinkSelection();
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
    // The gesture listeners are removed on pointerup+mouseup, pointercancel,
    // replacement pointerdown, and unmount so a cancelled drag cannot make a
    // later unrelated release parse paths or copy a disposed terminal.
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // 누르는 동안에는 hover dwell 을 돌리지 않는다 — 이 gesture 의 결과
      // (드래그면 selection, 클릭이면 point)가 검증을 소유한다.
      cancelPathLinkHoverDwell();
      retirePointerSelectionGesture();
      // Invalidate an earlier async stat immediately, but leave its verified
      // decoration through mousedown so an ordinary path-link click can still
      // capture the target. The first real move clears it above.
      pathLinkSelectionSeq += 1;
      pointerSelectionGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        selectionChanged: false,
      };
      window.addEventListener("pointermove", handlePointerSelectionMove);
      window.addEventListener("pointerup", handlePointerSelectionUp);
      window.addEventListener("pointercancel", handlePointerSelectionCancel);
      window.addEventListener("mouseup", handlePointerSelectionMouseUp);
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
        lines.push(readIndentedLine(bufLine, y));
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
    const directInputCapture = createDirectInputCapture();
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
      if (route === "suppress") {
        if (
          currentParsingWriteSource === "replay" &&
          currentParsingGeneration !== undefined &&
          isBootstrapPrimaryDeviceAttributesReply(data)
        ) {
          writeTerminalBootstrapProtocolReply(instanceId, currentParsingGeneration, data).catch(
            () => {},
          );
        }
        return;
      }
      if (route === "human") {
        if (!localTerminalControlAllowed()) return;
        const submittedInputs = directInputCapture.push(data);
        const byteLength = textEncoder.encode(data).length;
        const attempt = beginTerminalInputDelivery(instanceId, byteLength);
        void writeToTerminal(instanceId, data).then(
          () => {
            settleTerminalInputDelivery(attempt, "succeeded");
            const lastUserInput = submittedInputs.at(-1);
            if (!lastUserInput) return;
            useTerminalStore.getState().updateInstanceInfo(instanceId, {
              lastUserInput,
              lastUserInputAt: Date.now(),
            });
          },
          (error: unknown) => {
            if (!settleTerminalInputDelivery(attempt, "failed") || cancelled) return;
            trace("terminal-human-input-write-failed", {
              bytes: byteLength,
              error: error instanceof Error ? error.name : "unknown",
            });
            notifyHumanInputDeliveryFailure();
          },
        );
        return;
      }
      // The backend binds protocol replies to the exact PTY generation. If a
      // retired xterm callback resolves after the pane id has been reused, its
      // reply must not enter or consume one-shot state from the replacement.
      if (currentParsingGeneration === undefined) return;
      writeTerminalProtocolReply(instanceId, currentParsingGeneration, data).catch(() => {});
    });

    // xterm emits legacy DEFAULT mouse reports as a Latin-1-style binary
    // string, not onData. Preserve each code unit as one PTY byte and keep this
    // human input on the same Local owner, exactly-once metrics, and failure
    // notification path as keyboard/IME/mouse onData. Binary reports never
    // participate in parser reply/replay routing or the recent-input model.
    terminal.onBinary((data) => {
      const generation = outputGeneration;
      if (!localTerminalControlAllowed() || generation === undefined) return;
      trace("terminal-onBinary", {
        bytes: data.length,
        preview: Array.from(data.slice(0, 16), (character) => character.charCodeAt(0)),
      });
      const attempt = beginTerminalInputDelivery(instanceId, data.length);
      void writeTerminalBinaryInput(instanceId, generation, data).then(
        () => {
          settleTerminalInputDelivery(attempt, "succeeded");
        },
        (error: unknown) => {
          if (!settleTerminalInputDelivery(attempt, "failed") || cancelled) return;
          trace("terminal-human-binary-input-write-failed", {
            bytes: data.length,
            error: error instanceof Error ? error.name : "unknown",
          });
          notifyHumanInputDeliveryFailure();
        },
      );
    });

    const nativeWindowsOutputStabilizer = new NativeWindowsOutputStabilizer();
    const wslInFrameCursorParkRecognizer = new WslInFrameCursorParkRecognizer();
    const isWindowsHost = navigator.userAgent.includes("Windows");
    let flushDeferredTerminalFit: () => void = () => {};
    let outputStabilizerDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stabilizedRefreshFrame: number | undefined;
    let deliverStabilizedEmissions:
      | ((
          emissions: StabilizedOutputEmission[],
          onParsed?: () => void,
          onDiscard?: () => void,
          geometryRevision?: number,
        ) => void)
      | undefined;
    const pendingStabilizerParsedCallbacks = new DeferredParsedCallbackQueue();
    let suppressBackendResizeDuringFit = false;
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
          const callbacks = nativeWindowsOutputStabilizer.hasHeldBytes
            ? undefined
            : pendingStabilizerParsedCallbacks.drain();
          const onDiscard =
            callbacks?.onDiscard ??
            (emissions.length > 0 ? pendingStabilizerParsedCallbacks.snapshotDiscard() : undefined);
          deliverStabilizedEmissions?.(emissions, callbacks?.onParsed, onDiscard);
          scheduleOutputStabilizerDeadline();
          flushDeferredTerminalFit();
        },
        Math.max(0, deadline - monotonicNow()),
      );
    };
    const resetOutputStabilizer = () => {
      clearOutputStabilizerDeadlineTimer();
      nativeWindowsOutputStabilizer.reset();
      wslInFrameCursorParkRecognizer.reset();
      pendingStabilizerParsedCallbacks.discard();
      if (stabilizedRefreshFrame !== undefined) {
        cancelAnimationFrame(stabilizedRefreshFrame);
        stabilizedRefreshFrame = undefined;
      }
    };
    // Discards every cursor belief this pane inferred from the byte stream that
    // `terminal.reset()` is about to throw away (issue #596). A backend
    // sequence gap — the subscriber queue filling under heavy output — is
    // exactly how a DEC 2026 frame's `?2026l` disappears, and
    // `isDec2026FrameOpen` has no other route back to false: it would then
    // report `dec-2026-frame-open` on every sync, downgrade Codex's cursor
    // parks to visibility-only, and leave the overlay caret pinned where the
    // frame opened while the real cursor keeps advancing. Paired with the
    // reset call so the two states cannot drift apart.
    // See `createShadowCursorState`.
    // The `baseY` drop this reset causes is not re-seeded here. `terminal.reset()`
    // has already emitted its synchronous `onScroll` by the time this runs, so a
    // re-seed from here is a no-op that only looks like protection (issue #602).
    // `withCompositionScrollRebuild` owns that window instead, from before the
    // reset until the replay has rebuilt the scrollback.
    const resetStreamDerivedCursorState = () => {
      Object.assign(shadowCursorRef.current, createShadowCursorState());
      clearParkSettleTimer();
      scheduleOverlayCaretUpdate();
    };
    // No repaint filter is armed around a backend resize: the bundled ConPTY
    // runtime never emits the legacy host repaint frame, so live PTY output
    // reaches xterm unfiltered (ADR-0067).
    const resizeBackendTerminal = (cols: number, rows: number) =>
      resizeTerminal(instanceId, cols, rows);
    // Handle terminal resize — notify backend PTY
    terminal.onResize(({ cols, rows }) => {
      if (!localTerminalControlAllowed()) return;
      if (suppressBackendResizeDuringFit) return;
      resizeBackendTerminal(cols, rows).catch(() => {});
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
      generation?: number;
      parkDeadline?: number;
      frameEndCursorAuthoritative?: boolean;
      stabilized?: boolean;
      attachEpoch?: number;
      geometryRevision?: number;
      compositionActive?: boolean;
      needsSyncOutputMonitor?: boolean;
    };
    const terminalWriteQueue = new TerminalWriteBatchQueue<TerminalWriteMetadata>();
    // Completion failures keep counting, but a broken renderer callback must
    // not turn a PTY flood into a console flood. Warn once per source+stage for
    // this mounted terminal generation; session teardown drops the set.
    const terminalWriteCallbackWarnings = new Set<string>();
    let terminalWriteRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTerminalWriteTurn: (() => void) | undefined;
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
    const startRemoteResizeSync = () => {
      remoteReturnResizeDirtyRef.current = true;
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (
        !remoteResizeSyncTarget ||
        remoteResizeSyncTarget.cols !== cols ||
        remoteResizeSyncTarget.rows !== rows
      ) {
        remoteResizeSyncTarget = {
          revision: ++remoteResizeSyncTargetRevision,
          cols,
          rows,
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
      const resize = resizeBackendTerminal(target.cols, target.rows);
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
    // Atlas clear + full repaint for this terminal alone. Reached both from our
    // own reflow paths and, through the wrapper below, from the shared-atlas
    // coordinator (issue #571) — so it must not report back into it.
    const rebuildRendererLocal = () => {
      trace("atlas-rebuild");
      recordTerminalOutputPipeline(instanceId, "atlasRebuilds");
      let cleared = true;
      try {
        (terminal as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
      } catch {
        // `?.()` already covers "method missing", so this is a real failure: the
        // atlas may be wiped while this terminal's model was not cleared. Say so
        // — a reporter that did not come back up must not be skipped (#571).
        cleared = false;
      }
      terminal.refresh(0, terminal.rows - 1);
      return cleared;
    };
    // What the shared-atlas coordinator runs on this terminal when *someone
    // else* cleared the atlas (issue #571). It must not report back.
    const rebuildRendererForForeignClear = () => {
      // A hidden terminal is never worked on (§8.4). Nothing it draws is
      // visible, and the hide→show return already rebuilds it unconditionally
      // — so the fan-out stays out and the repair still happens exactly once
      // (issue #573). Marking `reflowDirtyRef` here would instead force the
      // guarded-fit branch on return and pay for a second rebuild.
      if (isContainerHiddenRef.current) return;
      rebuildRendererLocal();
    };
    const rebuildTerminalRenderer = () => {
      let selfRebuilt = false;
      try {
        selfRebuilt = rebuildRendererLocal();
      } finally {
        // The atlas is shared with every terminal on the same render config, and
        // xterm re-syncs only the caller's model — the rest keep stale texture
        // coordinates and draw glyph fragments (issue #571). Report even if the
        // rebuild threw: the wipe may already have landed on the shared atlas.
        notifyTextureAtlasCleared(instanceId, selfRebuilt);
      }
      bindHelperTextareaEvents();
      scheduleOverlayCaretUpdate();
    };
    const performTerminalFit = (request: TerminalFitRequest) => {
      recordTerminalOutputPipeline(instanceId, "fits");
      const syncBackendResize = request.syncBackendResize || remoteReturnResizeDirtyRef.current;
      suppressBackendResizeDuringFit = syncBackendResize;
      try {
        fitAddon.fit();
      } finally {
        suppressBackendResizeDuringFit = false;
      }

      if (syncBackendResize) startRemoteResizeSync();

      if (request.rebuildAtlas || reflowDirtyRef.current) {
        rebuildTerminalRenderer();
        reflowDirtyRef.current = false;
      } else {
        bindHelperTextareaEvents();
        scheduleOverlayCaretUpdate();
      }
    };
    flushDeferredTerminalFit = () => {
      if (
        cancelled ||
        outputAttachParserBusy ||
        outputRepairInFlight ||
        nativeWindowsOutputStabilizer.hasOpenSequence ||
        pendingTerminalWrites > 0 ||
        terminalWriteQueue.depth > 0 ||
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
      // How long the layout change actually waited behind the write FIFO and the
      // quiet window. ADR-0026 bounds only the quiet wait, so under a flood this
      // is the number that says whether the fit was starved (issue #606).
      recordTerminalOutputPipeline(instanceId, "fitDeferredMaxMs", deferredFor);
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
      terminalParserAdmission.cancelPending("visible");
    };
    const releaseCurrentTerminalWriteTurn = () => {
      const release = releaseTerminalWriteTurn;
      releaseTerminalWriteTurn = undefined;
      release?.();
    };
    const scheduleTerminalWritePump = (delayMs = 0) => {
      if (
        cancelled ||
        pendingTerminalWrites > 0 ||
        terminalWriteQueue.depth === 0 ||
        terminalWriteRetryTimer !== undefined
      ) {
        return;
      }
      if (delayMs > 0) {
        terminalWriteRetryTimer = setTimeout(() => {
          terminalWriteRetryTimer = undefined;
          scheduleTerminalWritePump();
        }, delayMs);
        return;
      }
      terminalParserAdmission.request("visible", (release, { contended }) => {
        if (cancelled || pendingTerminalWrites > 0 || terminalWriteQueue.depth === 0) {
          release();
          return;
        }
        releaseTerminalWriteTurn = release;
        try {
          flushDeferredTerminalWrites(
            contended ? TERMINAL_WRITE_FAIR_QUANTUM_BYTES : TERMINAL_WRITE_BATCH_MAX_BYTES,
          );
        } finally {
          // Async accepted writes retain the lease through their parse callback.
          // Synchronous callbacks and all rejection paths have no in-flight write.
          if (pendingTerminalWrites === 0) releaseCurrentTerminalWriteTurn();
        }
      });
    };
    const clearCurrentParsingWrite = () => {
      currentParsingWriteSource = undefined;
      currentParsingParkDeadline = undefined;
      currentParsingFrameEndCursorAuthoritative = false;
      currentParsingAttachEpoch = undefined;
      currentParsingGeneration = undefined;
    };
    const tryTerminalWrite = (batch: PreparedTerminalWriteBatch<TerminalWriteMetadata>) => {
      const submittedAt = monotonicNow();
      pendingTerminalWrites = 1;
      currentParsingWriteSource = batch.metadata.source;
      currentParsingParkDeadline = batch.metadata.parkDeadline;
      currentParsingFrameEndCursorAuthoritative =
        batch.metadata.frameEndCursorAuthoritative === true;
      currentParsingAttachEpoch = batch.metadata.attachEpoch;
      currentParsingGeneration = batch.metadata.generation;
      const onWriteParsed = () => {
        pendingTerminalWrites = 0;
        clearCurrentParsingWrite();

        type CallbackFailure = {
          stage: TerminalWriteCallbackFailureStage;
          error: unknown;
        };
        const failures: CallbackFailure[] = [];
        const runCompletionStep = (stage: TerminalWriteCallbackFailureStage, step: () => void) => {
          try {
            step();
          } catch (error) {
            failures.push({ stage, error });
          }
        };
        const reportCallbackFailures = (reported: readonly CallbackFailure[]) => {
          if (reported.length === 0) return;
          for (const failure of reported) {
            // Diagnostics must never become another exception inside xterm's
            // callback. xterm advances its buffer offset and subtracts the
            // accepted bytes only after this callback returns.
            try {
              recordTerminalOutputPipeline(instanceId, "writeCallbackFailures");
              recordTerminalOutputPipeline(
                instanceId,
                TERMINAL_WRITE_CALLBACK_SOURCE_COUNTER[batch.metadata.source],
              );
              recordTerminalOutputPipeline(
                instanceId,
                TERMINAL_WRITE_CALLBACK_STAGE_COUNTER[failure.stage],
              );
            } catch {
              // Best-effort diagnostics cannot safely recurse into themselves.
            }
          }
          const firstWarnings = reported.filter(({ stage }) => {
            const key = `${batch.metadata.source}:${stage}`;
            if (terminalWriteCallbackWarnings.has(key)) return false;
            terminalWriteCallbackWarnings.add(key);
            return true;
          });
          if (firstWarnings.length === 0) return;
          try {
            console.warn("[TerminalView] xterm write callback failed:", {
              source: batch.metadata.source,
              attachEpoch: batch.metadata.attachEpoch,
              firstId: batch.firstId,
              lastId: batch.lastId,
              failures: firstWarnings.map(({ stage, error }) => {
                let message = "unknown callback failure";
                try {
                  message = error instanceof Error ? error.message : String(error);
                } catch {
                  // An exotic thrown value may itself reject stringification.
                }
                return { stage, message };
              }),
            });
          } catch {
            // A patched console must not poison xterm's accepted-write state.
          }
        };

        try {
          runCompletionStep("metrics", () => {
            recordTerminalOutputPipeline(
              instanceId,
              "xtermParseMaxMs",
              Math.max(0, monotonicNow() - submittedAt),
            );
          });
          if (batch.entries.some(({ metadata }) => metadata.needsSyncOutputMonitor === true)) {
            runCompletionStep("monitor", startSyncOutputMonitor);
          }
          for (const entry of batch.entries) {
            if (entry.onParsed) runCompletionStep("consumer", entry.onParsed);
          }
          if (
            batch.metadata.stabilized &&
            !cancelled &&
            batch.metadata.attachEpoch === outputAttachEpoch &&
            terminal.rows > 0
          ) {
            runCompletionStep("refresh", () => {
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
                    batch.metadata.attachEpoch === outputAttachEpoch &&
                    terminal.rows > 0
                  ) {
                    if (isContainerHiddenRef.current) {
                      reflowDirtyRef.current = true;
                    } else {
                      try {
                        terminal.refresh(0, terminal.rows - 1);
                      } catch (error) {
                        reportCallbackFailures([{ stage: "refresh", error }]);
                      }
                    }
                  }
                });
              }
            });
          }
        } catch (error) {
          // The classified steps above are independently guarded. Keep one
          // final catch so future completion work cannot accidentally escape
          // into xterm before receiving an explicit stage.
          failures.push({ stage: "unknown", error });
        } finally {
          runCompletionStep("drain", () => {
            if (terminalWriteQueue.depth > 0) {
              // One physical write per task keeps automation/input responsive
              // while a flood drains; the fixed batch budget bounds each task.
              scheduleTerminalWritePump();
            } else {
              clearTerminalWriteRetryTimer();
              flushDeferredTerminalFit();
            }
          });
          reportCallbackFailures(failures);
          releaseCurrentTerminalWriteTurn();
        }
      };
      return attemptTerminalWrite({
        // This is the complete admission boundary. Once it returns, diagnostics
        // are forbidden from reclassifying the accepted bytes as discarded.
        write: () => terminal.write(batch.data, onWriteParsed),
        isBackpressure: isXtermWriteBackpressure,
        onAccepted: () => {
          // Count only accepted physical writes, never failed attempts or retries.
          recordTerminalOutputPipeline(instanceId, "xtermWrites");
          recordTerminalOutputPipeline(instanceId, "xtermWriteBytes", batch.byteLength);
          recordTerminalOutputPipeline(instanceId, "writeBatchMaxParts", batch.partCount);
          recordTerminalOutputPipeline(
            instanceId,
            "writeSubmitMaxMs",
            Math.max(0, monotonicNow() - submittedAt),
          );
        },
        restoreBackpressure: () => {
          pendingTerminalWrites = 0;
          clearCurrentParsingWrite();
          // Restore the exact dequeued object before any warning/counter. Both
          // its callbacks and its `warned` state belong to this retry.
          terminalWriteQueue.restore(batch);
        },
        onBackpressure: () => recordTerminalOutputPipeline(instanceId, "writeBackpressure"),
        onRejectedWarning: (error) => {
          if (batch.warned) return;
          batch.warned = true;
          console.warn("[TerminalView] xterm write failed:", error);
        },
        onDiscard: () => {
          pendingTerminalWrites = 0;
          clearCurrentParsingWrite();
          for (const entry of batch.entries) {
            try {
              entry.onDiscard?.();
            } catch {
              // A consumer cannot change the already-rejected byte outcome or
              // prevent later entries from receiving lifecycle cancellation.
            }
          }
        },
      });
    };
    function flushDeferredTerminalWrites(maxCoalescedBytes: number) {
      if (cancelled || pendingTerminalWrites > 0) return;
      const batch = terminalWriteQueue.dequeue(
        terminalWriteQueue.lastEnqueuedId,
        !compositionPreviewRef.current.active,
        maxCoalescedBytes,
      );
      if (!batch) {
        if (terminalWriteQueue.depth === 0) {
          clearTerminalWriteRetryTimer();
          flushDeferredTerminalFit();
        }
        return;
      }
      if (!tryTerminalWrite(batch)) {
        scheduleTerminalWritePump(TERMINAL_WRITE_RETRY_MS);
        return;
      }
      // Test doubles may invoke xterm's callback synchronously. Production waits
      // for that callback; in either case the next accepted write starts in a new
      // macrotask rather than recursively draining the entire backlog.
      if (pendingTerminalWrites === 0) {
        if (terminalWriteQueue.depth > 0) {
          scheduleTerminalWritePump();
        } else {
          // A synchronous accepted callback already reached this gate, making
          // this a no-op. A non-backpressure synchronous failure has no callback,
          // so this explicit path preserves the old fail-open fit release.
          clearTerminalWriteRetryTimer();
          flushDeferredTerminalFit();
        }
      }
    }
    const trackedTerminalWrite = (
      data: string | Uint8Array,
      onParsed?: () => void,
      metadata: TerminalWriteMetadata = { source: "replay" },
      onDiscard?: () => void,
    ) => {
      const chunks: Array<string | Uint8Array> = [];
      if (metadata.stabilized || typeof data === "string") {
        // The stabilizer already bounds this request to 1 MiB. Keep the frame
        // end and exact cursor restore in one xterm write so its parser cannot
        // paint the transient footer cursor between chunk callbacks.
        chunks.push(data);
      } else {
        // Ordinary byte writes enter the logical FIFO in fairness-sized slices.
        // A sole owner may coalesce four compatible slices back to 256 KiB;
        // when another owner waits, one scheduler turn stays bounded at 64 KiB.
        // Replay remains a per-entry barrier, so its 64 KiB slices are never
        // coalesced with each other or with a different logical request.
        chunks.push(...terminalWriteFairSlices(data));
      }
      if (chunks.length === 0) chunks.push(data);
      recordTerminalOutputPipeline(instanceId, "writeRequests");
      const requestMetadata: TerminalWriteMetadata = {
        ...metadata,
        compositionActive: compositionPreviewRef.current.active,
      };
      const batchKey =
        metadata.source === "live"
          ? `${metadata.attachEpoch ?? -1}:${metadata.geometryRevision ?? -1}`
          : undefined;
      chunks.forEach((chunk, index) => {
        terminalWriteQueue.enqueue({
          data: chunk,
          metadata: requestMetadata,
          batchKey,
          allowCoalescing: batchKey !== undefined,
          // Ordinary live entries in the same epoch/geometry may share one
          // physical parse boundary. The prepared batch retains every logical
          // parsed/discard callback, preserving ACK holes while restoring the
          // ADR-0080 flood coalescing path.
          coalesceCallbacks: batchKey !== undefined,
          onParsed: index === chunks.length - 1 ? onParsed : undefined,
          // Any rejected physical chunk invalidates the logical sequence
          // range. Promise settlement is one-shot, so sharing the callback is
          // safe and prevents an early chunk failure from stranding credit.
          onDiscard,
        });
      });
      recordTerminalOutputPipeline(instanceId, "writeQueueMaxDepth", terminalWriteQueue.depth);
      recordTerminalOutputPipeline(instanceId, "writeQueueMaxBytes", terminalWriteQueue.bytes);
      if (pendingTerminalWrites === 0) {
        // Even the first physical write joins the app-wide round-robin. Direct
        // admission here would let a newly busy pane bypass already waiting ones.
        scheduleTerminalWritePump();
      }
    };
    const trackedTerminalWriteAsync = (
      data: string | Uint8Array,
      metadata: TerminalWriteMetadata = { source: "replay" },
    ) => new Promise<void>((resolve) => trackedTerminalWrite(data, resolve, metadata, resolve));
    resumeDeferredTerminalWrites = () => {
      if (pendingTerminalWrites === 0 && terminalWriteQueue.depth > 0) {
        scheduleTerminalWritePump();
      }
    };
    let unlistenOutput: (() => void) | undefined;
    let unlistenOutputV3: (() => void) | undefined;
    let unlistenOutputFailStopped: (() => void) | undefined;
    let outputListenerReady: Promise<void> = Promise.resolve();
    let outputAttachRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let outputRepairRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let outputAttachEpoch = 0;
    let outputAttachInFlight = false;
    let outputRepairInFlight = false;
    let outputAttachTimeoutStreak = 0;
    let outputAckTimeoutStreak = 0;
    const outputControlOperations = terminalOutputControlOperationRegistry.mount(instanceId);
    /** Parsed-credit sender owned by exactly one backend attach lease. */
    let outputFlowAcknowledger: TerminalOutputFlowAcknowledger | undefined;
    type OutputTransportMode = "pending" | "v2" | "v3" | "fail-stop";
    let outputTransportMode: OutputTransportMode = "pending";
    const outputIsFailStopped = () => outputTransportMode === "fail-stop";
    let bufferedOutputV3: unknown | undefined;
    let hasBufferedOutputV3 = false;
    let outputV3FailStoppedReason: string | null = null;
    let outputV3Runtime: TerminalOutputV3Runtime | undefined;
    const outputPullWatchdogCadence = new TerminalOutputPullWatchdogCadence(monotonicNow());
    const outputV3FailureCoordinator = new TerminalOutputV3FailureCoordinator(
      instanceId,
      failStopTerminalOutputSurface,
    );
    let outputV3ContinuationTimer: ReturnType<typeof setTimeout> | undefined;
    let outputV3ParsersReady = false;
    let outputV3DiagnosticEntry: TerminalOutputV3DiagnosticEntry | undefined;
    let publishOutputV3Diagnostics: (() => void) | undefined;
    let disposeOutputV3DiagnosticsProvider: (() => void) | undefined;
    let cacheRestorePromise: Promise<string | null> = Promise.resolve(null);
    const outputCoordinator = new TerminalOutputAttachCoordinator();
    const renderCheckpointModel = new TerminalRenderCheckpointModel({
      admission: terminalParserAdmission,
    });
    registerTerminalRenderCheckpointProvider(instanceId, (target, maxBytes) =>
      renderCheckpointModel.capture(target, maxBytes),
    );
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
      onDiscard?: () => void,
    ) => {
      if (cancelled) return;
      if (data.length === 0) return;
      trackedTerminalWrite(
        data,
        onParsed,
        { ...metadata, needsSyncOutputMonitor: true },
        onDiscard,
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
    deliverStabilizedEmissions = (emissions, onParsed, onDiscard, geometryRevision) => {
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
            frameEndCursorAuthoritative: emission.frameEndCursorAuthoritative,
            attachEpoch: outputAttachEpoch,
            generation: outputGeneration,
            geometryRevision,
          },
          // One logical parsed-credit range may fan out into several physical
          // stabilized emissions. Any one of them being discarded invalidates
          // the whole range, so every emission shares the queue's one-shot
          // discard callback; only the final emission may report parse success.
          onDiscard,
        );
      });
    };
    const processLiveTerminalOutput = (
      data: Uint8Array,
      onParsed?: () => void,
      onDiscard?: () => void,
      geometryRevision?: number,
    ) => {
      if (!stabilizeNativeWindowsOutput) {
        if (initialExecutionHost === "wsl") {
          deliverStabilizedEmissions?.(
            wslInFrameCursorParkRecognizer.push(data),
            onParsed,
            onDiscard,
            geometryRevision,
          );
        } else {
          processTerminalOutput(
            data,
            onParsed,
            {
              source: "live",
              attachEpoch: outputAttachEpoch,
              generation: outputGeneration,
              geometryRevision,
            },
            onDiscard,
          );
        }
        return;
      }
      // Earlier logical segments intentionally have no `onParsed`, but their
      // discard callback still guards the same ACK range. Preserve those
      // discard-only entries until every held byte is emitted.
      if (onParsed || onDiscard) pendingStabilizerParsedCallbacks.push(onParsed, onDiscard);
      const emissions = nativeWindowsOutputStabilizer.push(data, monotonicNow());
      const callbacks = nativeWindowsOutputStabilizer.hasHeldBytes
        ? undefined
        : pendingStabilizerParsedCallbacks.drain();
      // `push()` may emit a plain prefix while simultaneously holding a frame
      // tail. Keep parse completion queued for that tail, but attach a
      // non-destructive snapshot discard to the immediate prefix so its
      // rejection cannot later be overwritten by the tail's successful parse.
      const immediateDiscard =
        callbacks?.onDiscard ??
        (emissions.length > 0 ? pendingStabilizerParsedCallbacks.snapshotDiscard() : undefined);
      deliverStabilizedEmissions?.(
        emissions,
        callbacks?.onParsed,
        immediateDiscard,
        geometryRevision,
      );
      scheduleOutputStabilizerDeadline();
    };
    const setOutputReady = (ready: boolean) => {
      outputProtocolReadyRef.current = ready;
      // Readiness is published as the owning xterm generation, so any later
      // rebuild reads as "not ready" without a reset effect.
      if (!cancelled) setOutputProtocolReadyGeneration(ready ? terminalGeneration : -1);
    };
    const isCurrentOutputV3Runtime = (runtime: TerminalOutputV3Runtime) =>
      !cancelled &&
      runtime === outputV3Runtime &&
      outputTransportMode === "v3" &&
      outputV3FailStoppedReason === null;
    const armOutputV3ContinuationDeadline = (runtime: TerminalOutputV3Runtime) => {
      if (!isCurrentOutputV3Runtime(runtime)) return;
      if (outputV3ContinuationTimer !== undefined) {
        clearTimeout(outputV3ContinuationTimer);
        outputV3ContinuationTimer = undefined;
      }
      const deadline = runtime.continuationDeadline;
      if (deadline === undefined) return;
      const delayMs = Math.max(1, Math.ceil(deadline - monotonicNow()));
      outputV3ContinuationTimer = setTimeout(() => {
        outputV3ContinuationTimer = undefined;
        if (!isCurrentOutputV3Runtime(runtime)) return;
        void runtime.flushExpired(monotonicNow()).finally(() => {
          if (!isCurrentOutputV3Runtime(runtime)) return;
          publishOutputV3Diagnostics?.();
          armOutputV3ContinuationDeadline(runtime);
        });
      }, delayMs);
    };
    const failStopOutputV3 = (reason: string, reportBackend = true) => {
      if (outputTransportMode === "fail-stop") return;
      outputTransportMode = "fail-stop";
      outputV3FailStoppedReason = reason;
      if (outputAttachRetryTimer !== undefined) {
        clearTimeout(outputAttachRetryTimer);
        outputAttachRetryTimer = undefined;
      }
      if (outputRepairRetryTimer !== undefined) {
        clearTimeout(outputRepairRetryTimer);
        outputRepairRetryTimer = undefined;
      }
      if (reportBackend) outputV3FailureCoordinator.reportLocal(reason);
      outputV3ParsersReady = false;
      setOutputReady(false);
      if (!cancelled) setOutputFailStop({ generation: terminalGeneration, reason });
      if (outputV3DiagnosticEntry) {
        outputV3DiagnosticEntry = {
          ...outputV3DiagnosticEntry,
          state: "fail-stopped",
          reason,
        };
        recordTerminalOutputV3Diagnostics(instanceId, outputV3DiagnosticEntry);
      }
      outputFlowAcknowledger?.dispose();
      outputV3Runtime?.dispose();
      if (outputV3ContinuationTimer !== undefined) {
        clearTimeout(outputV3ContinuationTimer);
        outputV3ContinuationTimer = undefined;
      }
      console.warn("[TerminalView] terminal output v3 fail-stopped; close/recreate required", {
        terminalId: instanceId,
        reason,
      });
    };
    const receiveOutputV3FailStop = (failure: TerminalOutputSurfaceFailStoppedPayload) => {
      if (cancelled) return;
      const reason = outputV3FailureCoordinator.receiveBackend(failure);
      if (reason) failStopOutputV3(reason, false);
    };
    const activateOutputV3 = async (
      epoch: number,
      generation: number,
      leaseToken: string,
      initialSeq: number,
      initialEnvelopeId: number,
      flow: TerminalOutputFlowAcknowledger,
    ) => {
      const isCurrent = () =>
        !cancelled &&
        epoch === outputAttachEpoch &&
        outputTransportMode === "v3" &&
        outputV3FailStoppedReason === null;
      const { TerminalOutputV3Runtime } = await loadTerminalOutputV3Runtime();
      if (!isCurrent()) return;
      const runtime = new TerminalOutputV3Runtime({
        terminalId: instanceId,
        generation,
        leaseToken,
        attachEpoch: epoch,
        initialSeq,
        initialEnvelopeId,
        controlTimeoutMs: TERMINAL_OUTPUT_CONTROL_TIMEOUT_MS,
        repairTimeoutMs: TERMINAL_OUTPUT_REPAIR_TIMEOUT_MS,
        scope: outputControlOperations,
        isCurrent,
        applyCheckpoint: (delta) => renderCheckpointModel.apply(delta),
        enqueueVisible: (delta, onParsed, onDiscard) => {
          lastTerminalOutputAt = Date.now();
          clearDeferredResizeQuietTimer();
          recordTerminalOutputPipeline(instanceId, "segmentsIn");
          recordTerminalOutputPipeline(instanceId, "checkpointApplies");
          processLiveTerminalOutput(
            delta.data,
            onParsed,
            () => onDiscard("visible xterm discarded terminal output envelope"),
            delta.geometry.revision,
          );
        },
        sendParsedRange: async (seqStart, seqEnd) => {
          const accepted = await flow.completeAndWait(seqStart, seqEnd);
          if (isCurrent()) publishOutputV3Diagnostics?.();
          return accepted;
        },
        onRepairEventPending: () => outputPullWatchdogCadence.requireNextPoll(),
        onFailStop: failStopOutputV3,
        getLifecycleFacts: () => ({
          parsersReady: outputV3ParsersReady,
          disposed: cancelled,
          failStoppedReason: outputV3FailStoppedReason,
          stabilizerHolding: nativeWindowsOutputStabilizer.hasHeldBytes,
          capacityWaiting: pendingTerminalWrites > 0 || terminalWriteQueue.depth > 0,
        }),
      });
      outputV3Runtime = runtime;
      outputV3ParsersReady = true;
      const readOutputV3Diagnostics = (): TerminalOutputV3DiagnosticEntry | undefined => {
        if (!isCurrent()) return undefined;
        const snapshot = runtime.diagnostics();
        return {
          state: outputV3FailStoppedReason === null ? "active" : "fail-stopped",
          reason: outputV3FailStoppedReason,
          generation,
          leaseToken,
          attachEpoch: epoch,
          snapshotSeq: initialSeq,
          admittedSeq: snapshot.admittedSeq,
          parsedSeq: snapshot.parsedSeq,
          nextEnvelopeId: snapshot.nextEnvelopeId,
          activeGrantId: snapshot.activeGrantId,
          repairCount: snapshot.repairCount,
          lastRepairReason: snapshot.lastRepairReason,
        };
      };
      publishOutputV3Diagnostics = () => {
        const entry = readOutputV3Diagnostics();
        if (!entry) return;
        outputV3DiagnosticEntry = entry;
        recordTerminalOutputV3Diagnostics(instanceId, outputV3DiagnosticEntry);
      };
      disposeOutputV3DiagnosticsProvider?.();
      disposeOutputV3DiagnosticsProvider = registerTerminalOutputV3DiagnosticsProvider(
        instanceId,
        readOutputV3Diagnostics,
      );
      publishOutputV3Diagnostics();

      if (!hasBufferedOutputV3) return;
      const buffered = bufferedOutputV3;
      bufferedOutputV3 = undefined;
      hasBufferedOutputV3 = false;
      const receiving = runtime.receive(buffered, monotonicNow());
      armOutputV3ContinuationDeadline(runtime);
      const result = await receiving;
      if (!isCurrent()) return;
      armOutputV3ContinuationDeadline(runtime);
      publishOutputV3Diagnostics();
      if (result.kind === "fail-stop") failStopOutputV3(result.reason);
    };
    const receiveOutputV3 = (payload: unknown) => {
      if (cancelled || outputTransportMode === "v2" || outputTransportMode === "fail-stop") return;
      const runtime = outputV3Runtime;
      if (!runtime) {
        if (hasBufferedOutputV3) {
          failStopOutputV3("attach_buffer_overflow");
          return;
        }
        bufferedOutputV3 = payload;
        hasBufferedOutputV3 = true;
        return;
      }
      const receiving = runtime.receive(payload, monotonicNow());
      armOutputV3ContinuationDeadline(runtime);
      void receiving.then((result) => {
        if (!isCurrentOutputV3Runtime(runtime)) return;
        armOutputV3ContinuationDeadline(runtime);
        publishOutputV3Diagnostics?.();
        if (result.kind === "fail-stop") failStopOutputV3(result.reason);
      });
    };
    const invalidateOutputAttachEpoch = (
      expectedEpoch: number,
      replacementPending: boolean,
    ): boolean => {
      if (cancelled || expectedEpoch !== outputAttachEpoch) return false;
      // Invalidate every continuation belonging to the old snapshot before
      // accepting more listener deltas. Queued old-epoch bytes are already in
      // the replacement snapshot, so discard them rather than replaying them
      // again after reset. An accepted xterm write cannot be cancelled; wait for
      // its parse callback before the replacement attach reaches reset().
      // Discard callbacks below capture this epoch. Retire its sender and then
      // advance the epoch before invoking them, so a stale failure cannot
      // recursively replace the replacement attach.
      outputFlowAcknowledger?.dispose();
      outputFlowAcknowledger = undefined;
      outputAttachEpoch += 1;
      outputAttachInFlight = false;
      outputAttachParserBusy = replacementPending;
      setOutputReady(false);
      resetOutputStabilizer();
      outputCoordinator.beginAttach();
      terminalWriteQueue.clear(true);
      clearTerminalWriteRetryTimer();
      return true;
    };
    const stopOutputControlRecovery = (expectedEpoch: number): number | undefined => {
      if (!invalidateOutputAttachEpoch(expectedEpoch, false)) return undefined;
      // The backend producer stays bounded/fail-stopped on its last lease.
      flushDeferredTerminalFit();
      return outputAttachEpoch;
    };
    const scheduleOutputReattach = (
      expectedEpoch = outputAttachEpoch,
      initialDelayMs = TERMINAL_WRITE_RETRY_MS,
    ) => {
      if (outputTransportMode === "v3") {
        failStopOutputV3("replacement_attach_forbidden");
        return;
      }
      if (outputTransportMode === "fail-stop") return;
      if (outputAttachRetryTimer !== undefined) return;
      if (!invalidateOutputAttachEpoch(expectedEpoch, true)) return;
      const tryStartReplacementAttach = () => {
        if (cancelled || outputTransportMode === "fail-stop") {
          outputAttachRetryTimer = undefined;
          return;
        }
        if (pendingTerminalWrites > 0) {
          outputAttachRetryTimer = setTimeout(tryStartReplacementAttach, TERMINAL_WRITE_RETRY_MS);
          return;
        }
        outputAttachRetryTimer = undefined;
        void startOutputAttach();
      };
      outputAttachRetryTimer = setTimeout(tryStartReplacementAttach, initialDelayMs);
    };
    const waitForOutputControlCapacity = (
      kind: TerminalOutputControlOperationKind,
      expectedEpoch: number,
      timeoutStreak: number,
    ) => {
      const stoppedEpoch = stopOutputControlRecovery(expectedEpoch);
      if (stoppedEpoch === undefined) return;
      const retryDelayMs = boundedTerminalOutputControlBackoff(Math.max(1, timeoutStreak));
      outputControlOperations.waitForCapacity(kind, () => {
        if (cancelled || outputAttachEpoch !== stoppedEpoch) return;
        scheduleOutputReattach(stoppedEpoch, retryDelayMs);
      });
    };
    const applyOutputSegments = (segments: TerminalOutputAppliedSegment[]) => {
      if (segments.length === 0) return;
      const epoch = outputAttachEpoch;
      const flow = outputFlowAcknowledger;
      if (!flow) {
        console.warn("[TerminalView] terminal output flow lease is missing; reattaching");
        scheduleOutputReattach(epoch);
        return;
      }
      // ADR-0026's quiet window means "no PTY output arrived recently", so it has
      // to be stamped before stabilizer or xterm backpressure can delay it.
      lastTerminalOutputAt = Date.now();
      clearDeferredResizeQuietTimer();
      recordTerminalOutputPipeline(instanceId, "segmentsIn", segments.length);
      // Only the rendererless checkpoint may merge coordinator segments. Cursor
      // stabilization and every state detector consume the original boundaries
      // immediately, exactly as they did before ADR-0080. Moving this merge above
      // `processLiveTerminalOutput` changes the native stabilizer's 50 ms clock and
      // can reorder OSC/alternate-buffer state transitions.
      const checkpointSegments = coalesceTerminalOutputSegments(segments);
      recordTerminalOutputPipeline(instanceId, "checkpointApplies", checkpointSegments.length);
      const checkpointParsed = Promise.all(
        checkpointSegments.map((segment) => renderCheckpointModel.apply(segment)),
      ).then(() => undefined);
      let resolveVisibleParsed!: () => void;
      let rejectVisibleParsed!: (error: Error) => void;
      const visibleParsed = new Promise<void>((resolve, reject) => {
        resolveVisibleParsed = resolve;
        rejectVisibleParsed = reject;
      });
      const first = segments[0];
      const last = segments[segments.length - 1];
      flow.completeAfterBothParsed(first.seqStart, last.seqEnd, visibleParsed, checkpointParsed);
      // Install failure handling before enqueue: a test double may discard a
      // physical batch synchronously, and checkpoint apply may reject while a
      // stale epoch exits the loop.
      void Promise.all([visibleParsed, checkpointParsed]).catch((error) => {
        if (cancelled || epoch !== outputAttachEpoch) return;
        console.warn("[TerminalView] terminal output parse failed; reattaching:", error);
        scheduleOutputReattach(epoch);
      });
      // Keep the original segment boundaries on the live detector/stabilizer
      // path immediately. Only producer credit waits for the checkpoint.
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const isLast = index === segments.length - 1;
        processLiveTerminalOutput(
          segment.data,
          isLast ? resolveVisibleParsed : undefined,
          () => rejectVisibleParsed(new Error("visible xterm discarded terminal output")),
          segment.geometry.revision,
        );
      }
    };
    /**
     * Write the buffered prefix an attach produced, awaiting the last segment so
     * the caller only publishes readiness once the bytes reached the parser.
     *
     * Returns `false` when a newer attach took over mid-write.
     */
    const writeAttachedSegments = async (
      segments: TerminalOutputAppliedSegment[],
      isCurrentAttach: () => boolean,
      epoch: number,
      flow: TerminalOutputFlowAcknowledger,
    ) => {
      if (segments.length === 0) return isCurrentAttach();
      recordTerminalOutputPipeline(instanceId, "segmentsIn", segments.length);
      recordTerminalOutputPipeline(instanceId, "checkpointApplies", segments.length);
      // Queue the whole buffered prefix synchronously. Listener callbacks can
      // fire between awaits; enqueueing one-by-one would let a newer live delta
      // jump ahead of the second buffered segment in the checkpoint model even
      // though the visible xterm stayed ordered.
      const checkpointParsed = Promise.all(
        segments.map((segment) => renderCheckpointModel.apply(segment)),
      ).then(() => undefined);
      let resolveVisibleParsed!: () => void;
      let rejectVisibleParsed!: (error: Error) => void;
      const visibleParsed = new Promise<void>((resolve, reject) => {
        resolveVisibleParsed = resolve;
        rejectVisibleParsed = reject;
      });
      const first = segments[0];
      const last = segments[segments.length - 1];
      flow.completeAfterBothParsed(first.seqStart, last.seqEnd, visibleParsed, checkpointParsed);
      const parsedSuccessfully = Promise.all([visibleParsed, checkpointParsed]).then(
        () => true,
        (error) => {
          if (cancelled || epoch !== outputAttachEpoch) return false;
          console.warn("[TerminalView] buffered terminal output parse failed; reattaching:", error);
          scheduleOutputReattach(epoch);
          return false;
        },
      );
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (!isCurrentAttach()) return false;
        const isLast = index === segments.length - 1;
        processLiveTerminalOutput(
          segment.data,
          isLast ? resolveVisibleParsed : undefined,
          () => rejectVisibleParsed(new Error("visible xterm discarded terminal output")),
          segment.geometry.revision,
        );
        if (!isCurrentAttach()) return false;
      }
      if (!(await parsedSuccessfully)) return false;
      return isCurrentAttach();
    };
    const scheduleOutputRepairRetry = (
      gap: { expectedSeq: number; actualSeq: number },
      epoch: number,
    ) => {
      if (cancelled || outputRepairRetryTimer !== undefined) return;
      outputRepairRetryTimer = setTimeout(() => {
        outputRepairRetryTimer = undefined;
        if (cancelled || epoch !== outputAttachEpoch) return;
        void startOutputRepair(gap);
      }, TERMINAL_WRITE_RETRY_MS);
    };
    /**
     * Repair a `terminal-output-v2` delivery gap by pulling the exact missing
     * range out of the backend ring (ADR-0072).
     *
     * The visible xterm is authoritative up to `expectedSeq`, so nothing is
     * reset, no attach epoch is burned, and the ADR-0069 checkpoint model keeps
     * its `reconstructable` flag. Only a range the ring can no longer bridge —
     * or one that spans a resize, which a single delta cannot describe —
     * escalates to the screen-losing full reattach.
     *
     * A hole can need more than one round-trip, because the flood that lost the
     * first delta can lose another one while the repair is being served. Those
     * rounds loop here (up to `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS`) instead of
     * escalating, and every round is guarded by a watchdog: a round-trip that
     * never settles would otherwise leave `expectedSeq === null` forever, which
     * freezes the pane's output and grows `pending` without bound (issue #607).
     *
     * Deliberately does **not** call `resetStreamDerivedCursorState()` (issue
     * #596). That call is paired with `terminal.reset()` because a reset voids
     * every belief inferred from the discarded bytes. A repair discards nothing:
     * the buffer survives, so `cursorAbsY` / `commandStartLine` / the frame
     * snapshot still name live rows, and the stream stays byte-exact. In
     * particular `isDec2026FrameOpen` must stay open — the frame's `?2026l` was
     * undelivered, not destroyed, and it is inside the repair range, so it
     * reaches the same parser handler and closes the latch exactly as it would
     * have without the gap. Rebuilding here would instead promote the next
     * in-frame `?25h` to an authoritative cursor park.
     */
    const startOutputRepair = async (
      gap: { expectedSeq: number; actualSeq: number },
      trigger: "event-gap" | "pull-watchdog" = "event-gap",
    ) => {
      // An in-flight repair already owns this hole; its own pending drain picks
      // up whatever arrived behind it.
      if (cancelled || outputRepairInFlight) return;
      const epoch = outputAttachEpoch;
      if (outputAttachInFlight || !outputCoordinator.ready) {
        // A gap that lands inside an attach must not be dropped: the buffered
        // delta would then wait for output that may never come. Retry once the
        // attach settles, and let the epoch guard cancel the retry if the attach
        // turned into a full reattach that owns recovery itself.
        if (trigger === "event-gap") scheduleOutputRepairRetry(gap, epoch);
        return;
      }
      const generation = outputGeneration;
      if (generation === undefined) {
        scheduleOutputReattach();
        return;
      }
      outputRepairInFlight = true;
      let currentGap = gap;
      // Each failure mode gets its own counter, and which counter is decided by
      // *where* the round-trip failed rather than by matching an error message.
      // `ringEscalation` in particular must stay reserved for the one thing
      // ADR-0072 hangs a revisit condition on: the backend answering `null`.
      const escalate = (event: TerminalOutputRecoveryEvent, message: string, detail: unknown) => {
        console.warn(`[TerminalView] ${message}`, detail, {
          gap: currentGap,
          counters: recordTerminalOutputRecovery(instanceId, event),
        });
        scheduleOutputReattach();
      };
      try {
        // One hole may need several round-trips: the flood can reopen a gap
        // behind a range that was already served. Each round is another exact
        // query, so it keeps the screen — only the cap escalates (issue #607).
        for (let round = 1; ; round += 1) {
          const resumeSeq = outputCoordinator.beginRepair();
          let raw: Awaited<ReturnType<typeof resumeTerminalOutput>>;
          try {
            const request = resumeTerminalOutput(instanceId, generation, resumeSeq);
            const answer = await withTerminalOutputRepairWatchdog(request);
            if (answer === TERMINAL_OUTPUT_REPAIR_TIMED_OUT) {
              // The round-trip is orphaned but may still reject later; swallow
              // that so a dead channel does not surface as an unhandled
              // rejection after the pane already recovered by reattaching.
              void request.catch(() => {});
              if (cancelled || epoch !== outputAttachEpoch) return;
              escalate("repairTimeout", "terminal output repair timed out; reattaching", {
                timeoutMs: TERMINAL_OUTPUT_REPAIR_TIMEOUT_MS,
                resumeSeq,
                round,
              });
              return;
            }
            raw = answer;
          } catch (error) {
            if (cancelled || epoch !== outputAttachEpoch) return;
            escalate("repairFailure", "terminal output repair request failed:", error);
            return;
          }
          if (cancelled || epoch !== outputAttachEpoch) return;
          if (!raw) {
            escalate(
              "ringEscalation",
              "terminal output ring cannot bridge the gap; reattaching",
              null,
            );
            return;
          }
          let repair: TerminalOutputDelta;
          try {
            repair = normalizeTerminalOutputDelta(raw);
          } catch (error) {
            escalate("malformedDelta", "malformed terminal output repair range:", error);
            return;
          }
          let result: TerminalOutputApplyResult;
          try {
            result = outputCoordinator.completeRepair(repair);
          } catch (error) {
            const spansResize =
              error instanceof TerminalOutputRepairError && error.reason === "geometry-change";
            escalate(
              spansResize ? "geometryEscalation" : "repairFailure",
              "terminal output repair was refused:",
              error,
            );
            return;
          }
          if (result.kind === "gap") {
            // A second hole opened behind the repaired one. Nothing to do with
            // ring retention, so it must not land in `ringEscalation`.
            //
            // Whatever the round *did* bridge is already accounted for by the
            // coordinator — `expectedSeq` moved past those bytes — so writing
            // the segments is mandatory, not optional. Dropping them would break
            // the invariant that `expectedSeq` only advances over bytes the
            // caller actually wrote, and would leave the very cell loss this
            // path exists to prevent.
            applyOutputSegments(result.segments);
            const counters = recordTerminalOutputRecovery(instanceId, "nestedGap");
            const nextGap = { expectedSeq: result.expectedSeq, actualSeq: result.actualSeq };
            // `ready` is false when the served range never reached the surface
            // sequence at all: nothing was applied and `beginRepair()` would
            // throw, so that shape can only escalate.
            const repayable = outputCoordinator.ready && round < TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS;
            if (!repayable) {
              // `nestedGap` alone cannot say whether the screen survived — it is
              // counted per round, and most rounds are repaid by the next one.
              // The give-up gets its own bucket for the reason ADR-0072 gave
              // `ringEscalation` one: `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS` is a
              // cap this code invented, and this counter is the only evidence
              // that could ever justify moving it (issue #607).
              console.warn(
                "[TerminalView] terminal output gap could not be repaired; reattaching",
                { ...currentGap, nextGap, round },
                recordTerminalOutputRecovery(instanceId, "nestedGapEscalation"),
              );
              scheduleOutputReattach();
              return;
            }
            console.warn(
              "[TerminalView] terminal output gap reopened behind the repair; repairing again",
              { ...currentGap, nextGap, round },
              counters,
            );
            currentGap = nextGap;
            continue;
          }
          // An idle watchdog returns an empty exact range. It deliberately
          // exercises the same generation/geometry-safe splice path, but it is
          // not a recovery and must not pollute gap metrics or logs.
          if (trigger === "event-gap" || raw.data.length > 0) {
            console.warn(
              trigger === "pull-watchdog"
                ? "[TerminalView] terminal output pull watchdog recovered undelivered bytes"
                : "[TerminalView] terminal output gap repaired",
              { ...currentGap, repairedBytes: raw.data.length, round },
              recordTerminalOutputRecovery(instanceId, "repair"),
            );
          }
          applyOutputSegments(result.segments);
          return;
        }
      } catch (error) {
        // Safety net: every classified failure returned above, so anything here
        // is unexpected and must not be filed as a ring escalation either.
        if (cancelled || epoch !== outputAttachEpoch) return;
        escalate("repairFailure", "terminal output repair failed unexpectedly:", error);
      } finally {
        outputRepairInFlight = false;
        flushDeferredTerminalFit();
      }
    };
    const startOutputAttach = async () => {
      if (cancelled || outputIsFailStopped() || !terminalSessionReady || outputAttachInFlight) {
        return;
      }
      recordTerminalOutputPipeline(instanceId, "attaches");
      outputAttachInFlight = true;
      outputAttachParserBusy = true;
      outputFlowAcknowledger?.dispose();
      outputFlowAcknowledger = undefined;
      const epoch = ++outputAttachEpoch;
      resetOutputStabilizer();
      const isCurrentAttach = () => !cancelled && epoch === outputAttachEpoch;
      // A hole the attach itself uncovered. Handed to the repair from the
      // `finally` below rather than from inside the write chain, because
      // `outputAttachInFlight` is still true in there and `startOutputRepair`
      // would bounce off it into `scheduleOutputRepairRetry`'s timer.
      let attachWindowGap: { expectedSeq: number; actualSeq: number } | undefined;
      try {
        const attachOperation = outputControlOperations.tryStart("attach");
        if (!attachOperation) {
          const retryDelayMs = boundedTerminalOutputControlBackoff(
            Math.max(1, outputAttachTimeoutStreak),
          );
          recoverTerminalOutputControl(
            () => waitForOutputControlCapacity("attach", epoch, outputAttachTimeoutStreak),
            () =>
              console.warn(
                "[TerminalView] terminal output attach operation budget full; fail-stopping",
                {
                  epoch,
                  retryDelayMs,
                  outstanding: outputControlOperations.outstanding("attach"),
                },
              ),
          );
          return;
        }
        const attachOutcome = await settleTerminalOutputControl(
          Promise.resolve().then(() => attachTerminalOutput(instanceId)),
          TERMINAL_OUTPUT_CONTROL_TIMEOUT_MS,
          {
            onSettled: () => attachOperation.settle(),
          },
        );
        if (!isCurrentAttach()) return;
        if (attachOutcome.kind === "timeout") {
          outputAttachTimeoutStreak += 1;
          const retryDelayMs = boundedTerminalOutputControlBackoff(outputAttachTimeoutStreak);
          const hasCapacity = outputControlOperations.canStart("attach");
          recoverTerminalOutputControl(
            () =>
              hasCapacity
                ? scheduleOutputReattach(epoch, retryDelayMs)
                : waitForOutputControlCapacity("attach", epoch, outputAttachTimeoutStreak),
            () =>
              console.warn(
                hasCapacity
                  ? "[TerminalView] terminal output attach timed out; replacing epoch"
                  : "[TerminalView] terminal output attach orphan budget full; fail-stopping",
                {
                  epoch,
                  retryDelayMs,
                  timeoutStreak: outputAttachTimeoutStreak,
                  outstanding: outputControlOperations.outstanding("attach"),
                },
                recordTerminalOutputRecovery(instanceId, "attachTimeout"),
              ),
          );
          return;
        }
        if (attachOutcome.kind === "rejected") throw attachOutcome.error;
        outputAttachTimeoutStreak = 0;
        const rawAttachment = attachOutcome.value;
        // An answer that is not an object at all cannot be told apart from a
        // fail-stop by the `kind` probe below — `in` throws on it — and the
        // TypeError would surface as an unexplained attach failure instead of
        // the fail-stop path that knows how to recover.
        if (rawAttachment === null || typeof rawAttachment !== "object") {
          failStopOutputV3("malformed_attach_fail_stop", false);
          return;
        }
        if ("kind" in rawAttachment) {
          const backendFailureReason = outputV3FailureCoordinator.bindFailedAttach(rawAttachment);
          failStopOutputV3(backendFailureReason ?? "malformed_attach_fail_stop", false);
          return;
        }
        const cached = await cacheRestorePromise;
        if (!isCurrentAttach()) return;
        const attachment = normalizeTerminalOutputAttachment(rawAttachment);
        const { token, windowBytes, nextEnvelopeId } = rawAttachment.flowControl;
        if (
          typeof token !== "string" ||
          token.length === 0 ||
          !Number.isSafeInteger(windowBytes) ||
          windowBytes <= 0
        ) {
          throw new Error("malformed terminal output flow-control lease");
        }
        const supportsV3 = nextEnvelopeId !== undefined;
        if (supportsV3 && (!Number.isSafeInteger(nextEnvelopeId) || nextEnvelopeId <= 0)) {
          throw new Error("malformed terminal output v3 envelope identity");
        }
        if (outputTransportMode !== "fail-stop") {
          outputTransportMode = supportsV3 ? "v3" : "v2";
        }
        if (supportsV3) {
          const backendFailureReason = outputV3FailureCoordinator.bindIdentity(
            attachment.state.generation,
            token,
          );
          if (backendFailureReason) failStopOutputV3(backendFailureReason, false);
          if (outputTransportMode === "fail-stop") return;
          outputCoordinator.beginAttach();
        }
        let ackWarningReported = false;
        const flow = new TerminalOutputFlowAcknowledger(
          attachment.state.snapshotStartSeq,
          (seq) => acknowledgeTerminalOutput(instanceId, attachment.state.generation, token, seq),
          {
            onError: (error) => {
              if (ackWarningReported || !isCurrentAttach()) return;
              ackWarningReported = true;
              console.warn("[TerminalView] terminal output ACK failed; retrying:", error);
            },
            onLeaseLost: () => {
              if (!isCurrentAttach()) return;
              if (outputTransportMode === "v3") {
                failStopOutputV3("parsed_ack_stale");
                return;
              }
              recoverTerminalOutputControl(
                () => scheduleOutputReattach(epoch),
                () =>
                  console.warn(
                    "[TerminalView] terminal output ACK lease was replaced; reattaching",
                  ),
              );
            },
            tryStartOperation: () => outputControlOperations.tryStart("ack"),
            onAdmissionBlocked: (resume) => {
              if (!isCurrentAttach()) return;
              if (outputTransportMode === "v3") {
                if (outputControlOperations.orphanCapacityExhausted("ack")) {
                  failStopOutputV3("control_orphan_cap");
                  return;
                }
                return outputControlOperations.waitForCapacityOrTimeout("ack", resume);
              }
              const retryDelayMs = boundedTerminalOutputControlBackoff(
                Math.max(1, outputAckTimeoutStreak),
              );
              recoverTerminalOutputControl(
                () => waitForOutputControlCapacity("ack", epoch, outputAckTimeoutStreak),
                () =>
                  console.warn(
                    "[TerminalView] terminal output ACK operation budget full; fail-stopping",
                    {
                      epoch,
                      retryDelayMs,
                      outstanding: outputControlOperations.outstanding("ack"),
                    },
                  ),
              );
            },
            timeoutMs: TERMINAL_OUTPUT_CONTROL_TIMEOUT_MS,
            // v3 owns one irreplaceable lease, so a timed-out parsed ACK is
            // retried in place (same or later coalesced prefix) instead of
            // replacing the epoch. Each orphan stays charged in the registry;
            // `onAdmissionBlocked` above fail-stops at the orphan hard cap
            // (ADR-0095 control liveness).
            retryOnTimeout: supportsV3,
            onTimeout: () => {
              if (!isCurrentAttach()) return;
              if (outputTransportMode === "v3") {
                outputAckTimeoutStreak += 1;
                console.warn(
                  "[TerminalView] terminal output parsed ACK timed out; retrying same prefix",
                  {
                    epoch,
                    timeoutStreak: outputAckTimeoutStreak,
                    outstanding: outputControlOperations.outstanding("ack"),
                  },
                  recordTerminalOutputRecovery(instanceId, "ackTimeout"),
                );
                return;
              }
              outputAckTimeoutStreak += 1;
              const retryDelayMs = boundedTerminalOutputControlBackoff(outputAckTimeoutStreak);
              const hasCapacity = outputControlOperations.canStart("ack");
              recoverTerminalOutputControl(
                () =>
                  hasCapacity
                    ? scheduleOutputReattach(epoch, retryDelayMs)
                    : waitForOutputControlCapacity("ack", epoch, outputAckTimeoutStreak),
                () =>
                  console.warn(
                    hasCapacity
                      ? "[TerminalView] terminal output ACK timed out; replacing epoch"
                      : "[TerminalView] terminal output ACK orphan budget full; fail-stopping",
                    {
                      epoch,
                      retryDelayMs,
                      timeoutStreak: outputAckTimeoutStreak,
                      outstanding: outputControlOperations.outstanding("ack"),
                    },
                    recordTerminalOutputRecovery(instanceId, "ackTimeout"),
                  ),
              );
            },
            onConfirmed: () => {
              if (isCurrentAttach()) outputAckTimeoutStreak = 0;
            },
          },
        );
        outputFlowAcknowledger = flow;
        await renderCheckpointModel.attach(attachment);
        if (!isCurrentAttach()) return;

        // The whole rebuild is one composition-scroll window: `reset()` collapses
        // the scrollback and the replay below rebuilds it, so only the net shift
        // may reach an open composition anchor (issue #602).
        // A discarded stale replay rejects its epoch's chain by design. A new
        // attach must preserve serialization without inheriting that terminal
        // rejection forever.
        terminalOutputWriteChain = terminalOutputWriteChain
          .catch(() => {})
          .then(() =>
            withCompositionScrollRebuild(async () => {
              if (!isCurrentAttach()) return;
              terminal.reset();
              resetStreamDerivedCursorState();
              if (cached) {
                await trackedTerminalWriteAsync(cached);
                if (!isCurrentAttach()) return;
                // The persisted screen and the new PTY are different coordinate
                // spaces. Move the former into scrollback, then home xterm so the
                // backend's row-1 CUP/HVP writes (including typed-input echo) land
                // on the same live row as the initial prompt.
                await trackedTerminalWriteAsync(terminalRestoreBoundary(terminal.rows));
                if (!isCurrentAttach()) return;
              }
              if (attachment.snapshot.length > 0) {
                // Ring snapshot bytes actually replayed into xterm. The number that
                // settles whether a layout change costs a 1 MiB replay at all
                // (issue #606 hypothesised six of them per workspace flip).
                recordTerminalOutputPipeline(
                  instanceId,
                  "attachReplayBytes",
                  attachment.snapshot.length,
                );
                await new Promise<void>((resolve, reject) =>
                  processTerminalOutput(
                    attachment.snapshot,
                    resolve,
                    { source: "replay", generation: attachment.state.generation },
                    () => reject(new Error("visible xterm discarded terminal output snapshot")),
                  ),
                );
                if (!isCurrentAttach()) return;
              }
              // `renderCheckpointModel.attach` already parsed this exact snapshot;
              // release its range only after the visible replay also completed.
              if (supportsV3) {
                const snapshotConfirmed = await flow.completeAndWait(
                  attachment.state.snapshotStartSeq,
                  attachment.state.snapshotSeq,
                );
                if (!snapshotConfirmed || !isCurrentAttach()) {
                  failStopOutputV3("snapshot_parsed_ack_rejected");
                  return;
                }
              } else {
                flow.complete(attachment.state.snapshotStartSeq, attachment.state.snapshotSeq);
              }

              // Cache/snapshot may contain historic DEC mode changes. Apply the
              // backend's state last, to xterm only, before live sequenced deltas.
              await trackedTerminalWriteAsync(
                attachment.state.modes.bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l",
              );
              if (!isCurrentAttach()) return;
              outputGeneration = attachment.state.generation;
              if (supportsV3) {
                await activateOutputV3(
                  epoch,
                  attachment.state.generation,
                  token,
                  attachment.state.snapshotSeq,
                  nextEnvelopeId,
                  flow,
                );
                if (isCurrentAttach() && outputTransportMode === "v3") setOutputReady(true);
                return;
              }
              const buffered = outputCoordinator.completeAttach(attachment);
              if (buffered.kind === "gap") {
                console.warn(
                  "[TerminalView] terminal output gap during attach",
                  buffered,
                  recordTerminalOutputRecovery(instanceId, "gap"),
                );
                // The snapshot is the whole 1 MiB ring, so a delta lost during the
                // attach round-trip is still in the ring: repair the exact range
                // instead of escalating to another screen-losing reattach that would
                // only widen the window for the same loss (issue #607). The prefix
                // that arrived before the hole is applied first — the coordinator has
                // already moved `expectedSeq` past it.
                if (
                  !(await writeAttachedSegments(buffered.segments, isCurrentAttach, epoch, flow))
                ) {
                  return;
                }
                // Readiness belongs to the attach, not to the repair: from here the
                // hole is an ordinary mid-stream gap, and live deltas keep buffering
                // in the coordinator until the repair splices in front of them.
                setOutputReady(true);
                // Kicked from the attach's `finally`, one statement after
                // `outputAttachInFlight` drops: the round-trip then starts directly
                // instead of hopping through the retry timer, so the start latency
                // does not depend on `TERMINAL_WRITE_RETRY_MS` and a live delta
                // arriving in that window cannot race the attach for who owns the
                // hole.
                attachWindowGap = buffered;
                return;
              }
              if (await writeAttachedSegments(buffered.segments, isCurrentAttach, epoch, flow)) {
                setOutputReady(true);
              }
            }),
          );
        await terminalOutputWriteChain;
      } catch (error) {
        if (!cancelled && outputTransportMode !== "fail-stop" && epoch === outputAttachEpoch) {
          recoverTerminalOutputControl(
            () => scheduleOutputReattach(epoch),
            () =>
              console.warn(
                "[TerminalView] terminal output attach failed:",
                error,
                recordTerminalOutputRecovery(instanceId, "attachFailure"),
              ),
          );
        }
      } finally {
        if (epoch === outputAttachEpoch) {
          outputAttachInFlight = false;
          outputAttachParserBusy = false;
          flushDeferredTerminalFit();
          if (!cancelled && outputTransportMode === "v2" && !outputCoordinator.ready) {
            scheduleOutputReattach(epoch);
          }
          // `startOutputRepair` claims `outputRepairInFlight` synchronously, so
          // no listener delta can slip in front of this and start the same
          // round-trip from the other side.
          else if (attachWindowGap) void startOutputRepair(attachWindowGap);
        }
      }
    };

    const outputV2ListenerReady = onTerminalOutputV2(instanceId, (payload) => {
      if (cancelled || outputTransportMode === "v3" || outputTransportMode === "fail-stop") {
        return;
      }
      let result: TerminalOutputApplyResult;
      try {
        const delta: TerminalOutputDelta = normalizeTerminalOutputDelta(payload);
        result = outputCoordinator.ingest(delta);
        // Diagnostics never participate in delta validation/admission. A
        // broken counter must not relabel valid bytes as malformed or reset a
        // screen that the coordinator already advanced.
        try {
          recordTerminalOutputPipeline(instanceId, "deltaEvents");
          recordTerminalOutputPipeline(instanceId, "deltaBytes", delta.data.length);
        } catch {
          // Best effort only.
        }
      } catch (error) {
        try {
          console.warn(
            "[TerminalView] malformed terminal output delta:",
            error,
            recordTerminalOutputRecovery(instanceId, "malformedDelta"),
          );
        } catch {
          // Diagnostics are outside the delivery contract.
        }
        scheduleOutputReattach();
        return;
      }
      try {
        if (result.kind === "gap") {
          // The lost bytes are still in the backend ring, so repair the stream in
          // place instead of resetting the screen (ADR-0072).
          try {
            console.warn(
              "[TerminalView] terminal output gap",
              result,
              recordTerminalOutputRecovery(instanceId, "gap"),
            );
          } catch {
            // A counter or console failure cannot replace exact repair with a
            // screen-losing attach.
          }
          void startOutputRepair(result);
          return;
        }
        // This entire listener boundary is no-throw. Detector, stabilizer,
        // checkpoint, queue and diagnostic failures all invalidate this epoch
        // instead of escaping Tauri's JS callback and leaving backend credit
        // permanently outstanding.
        applyOutputSegments(result.segments);
      } catch (error) {
        try {
          console.warn("[TerminalView] terminal output pipeline failed; reattaching:", error);
        } catch {
          // A patched console cannot escape the Tauri callback boundary.
        }
        scheduleOutputReattach();
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenOutput = unlisten;
      }
    });
    const outputV3ListenerReady = onTerminalOutputV3(instanceId, receiveOutputV3).then(
      (unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenOutputV3 = unlisten;
        }
      },
    );
    const outputFailStoppedListenerReady = onTerminalOutputFailStopped(
      receiveOutputV3FailStop,
    ).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenOutputFailStopped = unlisten;
      }
    });
    outputListenerReady = Promise.all([
      outputV2ListenerReady,
      outputV3ListenerReady,
      outputFailStoppedListenerReady,
    ]).then(() => undefined);

    const outputPullWatchdogTimer = setInterval(() => {
      if (cancelled) return;
      const now = monotonicNow();
      // A moderate host-task stall can queue this timer beside the output edge
      // it is meant to recover. Give the direct event one full watchdog period
      // after the stall; long stalls still poll within the hard window.
      if (!outputPullWatchdogCadence.shouldPoll(now)) return;
      if (outputTransportMode === "v3") {
        const runtime = outputV3Runtime;
        if (!runtime || outputV3FailStoppedReason !== null) return;
        void runtime.pollExactRepair(now).then((result) => {
          publishOutputV3Diagnostics?.();
          if (result?.kind === "fail-stop") failStopOutputV3(result.reason);
        });
        return;
      }
      if (
        outputTransportMode !== "v2" ||
        outputAttachInFlight ||
        outputRepairInFlight ||
        !outputCoordinator.ready ||
        outputGeneration === undefined ||
        !outputFlowAcknowledger
      ) {
        return;
      }
      const expectedSeq = outputCoordinator.contiguousSeq;
      if (expectedSeq === null) return;
      // `startOutputRepair` claims the coordinator synchronously before its
      // first await, so adjacent interval ticks and live gap detection share a
      // single in-flight exact-resume request.
      void startOutputRepair({ expectedSeq, actualSeq: expectedSeq }, "pull-watchdog");
    }, TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS);

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

    // A PTY and its rendererless parsers are not visual resources. Start them
    // as soon as the startup coordinator mounts this TerminalView, even when
    // RDP/window layout currently leaves the xterm host at 0×N or N×0. The DOM
    // renderer remains size-gated below; xterm's parser/buffer and the Remote
    // checkpoint model both work before terminal.open() (ADR-0161).
    const isFreshRestart = isUserRestart && firstSessionStartRef.current;
    firstSessionStartRef.current = false;
    const shouldRestoreCwd = profileConfig?.restoreCwd ?? settingsState.profileDefaults.restoreCwd;
    const shouldRestoreOutput =
      profileConfig?.restoreOutput ?? settingsState.profileDefaults.restoreOutput;

    // Determine startup command override for Claude/Codex/Grok session restore.
    // Validate session ID format to prevent command injection.
    const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
    const shouldRestoreClaudeSession =
      !isFreshRestart && settingsState.claude?.restoreSession !== false;
    const safeSessionId =
      lastClaudeSession && SESSION_ID_PATTERN.test(lastClaudeSession)
        ? lastClaudeSession
        : undefined;
    const shouldRestoreCodexSession =
      !isFreshRestart && settingsState.codex?.restoreSession !== false;
    const safeCodexSessionId =
      lastCodexSession && SESSION_ID_PATTERN.test(lastCodexSession) ? lastCodexSession : undefined;
    const shouldRestoreGrokSession =
      !isFreshRestart && settingsState.grok?.restoreSession !== false;
    const GROK_SESSION_ID_PATTERN =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const safeGrokSessionId =
      lastGrokSession && GROK_SESSION_ID_PATTERN.test(lastGrokSession)
        ? lastGrokSession
        : undefined;
    const presentAgentSessionKeys = [lastClaudeSession, lastCodexSession, lastGrokSession].filter(
      (value) => typeof value === "string" && value.length > 0,
    ).length;
    const hasAgentSessionConflict = presentAgentSessionKeys > 1;
    // The launch command is configurable so a user can carry flags such as
    // `--dangerously-skip-permissions` / `--yolo` into the restored session.
    // Rust re-derives the same string from settings and rejects the rest.
    const claudeCommand = resolveAgentCommand(
      settingsState.claude?.command,
      DEFAULT_CLAUDE_COMMAND,
    );
    const codexCommand = resolveAgentCommand(settingsState.codex?.command, DEFAULT_CODEX_COMMAND);
    const grokCommand = resolveAgentCommand(settingsState.grok?.command, DEFAULT_GROK_COMMAND);
    const startupOverride = startupCommandOverride
      ? startupCommandOverride
      : hasAgentSessionConflict
        ? undefined
        : shouldRestoreClaudeSession && safeSessionId
          ? `${claudeCommand} --resume ${safeSessionId}`
          : shouldRestoreCodexSession && safeCodexSessionId
            ? `${codexCommand} resume ${safeCodexSessionId}`
            : shouldRestoreGrokSession && safeGrokSessionId
              ? `${grokCommand} --resume ${safeGrokSessionId}`
              : undefined;

    cacheRestorePromise =
      !isFreshRestart && shouldRestoreOutput && paneId
        ? loadTerminalOutputCache(paneId)
            .then((cached) =>
              cancelled || !cached || cached.length === 0 ? null : normalBufferOnly(cached),
            )
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (!msg.startsWith("Cache not found:")) {
                console.warn(`[TerminalView] Unexpected error restoring cache for ${paneId}:`, err);
              }
              return null;
            })
        : Promise.resolve(null);

    // Start PTY session immediately (don't wait for cache restore or a visual
    // surface). Cache restore runs in parallel so the shell starts booting ASAP.
    if (!cancelled) {
      createTerminalSession(
        instanceId,
        profile,
        terminal.cols,
        terminal.rows,
        syncGroup,
        cwdSendRef.current,
        cwdReceiveRef.current,
        isFreshRestart ? restartCwd : shouldRestoreCwd ? lastCwd : undefined,
        viewerStartup ?? startupOverride,
      )
        .then((createdSession) => {
          initialExecutionHost = createdSession.initialExecutionHost ?? "unknown";
          stabilizeNativeWindowsOutput = shouldStabilizeInitialExecutionHost(initialExecutionHost);
          terminalSessionReady = true;
          if (cancelled) return;
          useTerminalStore.getState().updateInstanceInfo(instanceId, {
            sessionReady: true,
            // The backend seeds the session CWD from the PTY's actual start
            // directory, and that seed produces no `terminal-cwd-changed`
            // event. A resumed agent pane may never emit an accepted OSC 7,
            // so this reply is the only CWD its sync group will observe.
            ...(createdSession.cwd ? { cwd: createdSession.cwd } : {}),
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
          trackedTerminalWrite(`\r\n\x1b[31mFailed to create terminal session: ${err}\x1b[0m\r\n`);
          settleFailedStartup();
        })
        .finally(() => {
          if (isFreshRestart) onUserRestartConsumed?.();
        });
    }

    // Wait for container to have actual dimensions before opening terminal.
    // xterm.js viewport gets height 0 if opened in a zero-sized container,
    // causing rendering artifacts (garbled first row).
    let terminalOpened = false;
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
      // #687: reflow 뒤 라벨 좌표는 더 이상 밑줄과 맞지 않는다(스크롤과 동일 이유).
      pathLinkHint.hide();
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
      if (width > 0 && height > 0 && !terminalOpened) {
        terminalOpened = true;
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
        // Rebuild hook for a foreign atlas clear (issue #571). Registered under
        // the instance id only — a second registration under paneId would
        // rebuild this terminal twice per clear.
        registerAtlasRebuilder(instanceId, rebuildRendererForForeignClear);

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
      } else if (terminalOpened && width > 0 && height > 0) {
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
      if (outputTransportMode === "v3") {
        // There is no earlier lifecycle signal that distinguishes a terminal
        // close from a disappearing WebView surface. Publish before `cancelled`
        // retires the identity; a concurrent explicit close may safely make
        // this best-effort command return stale/false.
        outputV3FailureCoordinator.disposeSurface();
      }
      cancelled = true;
      outputV3Runtime?.dispose();
      outputV3Runtime = undefined;
      disposeOutputV3DiagnosticsProvider?.();
      disposeOutputV3DiagnosticsProvider = undefined;
      publishOutputV3Diagnostics = undefined;
      outputV3DiagnosticEntry = undefined;
      forgetTerminalOutputV3Diagnostics(instanceId);
      if (outputV3ContinuationTimer !== undefined) {
        clearTimeout(outputV3ContinuationTimer);
        outputV3ContinuationTimer = undefined;
      }
      outputFlowAcknowledger?.dispose();
      outputFlowAcknowledger = undefined;
      outputControlOperations.dispose();
      outputAttachEpoch += 1;
      outputProtocolReadyRef.current = false;
      if (outputAttachRetryTimer !== undefined) clearTimeout(outputAttachRetryTimer);
      if (outputRepairRetryTimer !== undefined) clearTimeout(outputRepairRetryTimer);
      if (outputPullWatchdogTimer !== undefined) clearInterval(outputPullWatchdogTimer);
      resetOutputStabilizer();
      deliverStabilizedEmissions = undefined;
      if (guardedTerminalFitRef.current === requestGuardedTerminalFit) {
        guardedTerminalFitRef.current = null;
      }
      deferredTerminalFit = undefined;
      deferredResizeRequestedAt = 0;
      clearDeferredResizeQuietTimer();
      terminalWriteQueue.clear(true);
      pendingTerminalWrites = 0;
      clearCurrentParsingWrite();
      resumeDeferredTerminalWrites = undefined;
      clearTerminalWriteRetryTimer();
      terminalParserAdmission.cancel("visible");
      releaseTerminalWriteTurn = undefined;
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
      cancelPathLinkHoverDwell();
      outerEl?.removeEventListener("keydown", handleKeyDown);
      outerEl?.removeEventListener("mousemove", handleMouseMove);
      outerEl?.removeEventListener("mouseleave", handleMouseLeave);
      pathLinkHint.dispose();
      outerEl?.removeEventListener("pointerdown", handlePointerDown);
      outerEl?.removeEventListener("mousedown", handlePathLinkMouseDown, true);
      window.removeEventListener("mouseup", handlePathLinkMouseUp);
      wrapperEl?.removeEventListener("mousedown", handleModifierLinkClick, true);
      for (const eventName of humanDataEvents) {
        wrapperEl?.removeEventListener(eventName, markHumanDataEmission, true);
      }
      xtermUserInputOriginDisposable?.dispose();
      retirePointerSelectionGesture();
      window.removeEventListener("blur", handleAppBlurForFocusOwnership);
      window.removeEventListener("focus", handleAppFocusForFocusOwnership);
      window.removeEventListener("pointerdown", handlePointerDownForFocusOwnership, true);
      focusOwnershipSurface?.removeEventListener("focusout", handleFocusOutForFocusOwnership);
      helperTextarea?.removeEventListener("beforeinput", handleBeforeInputForChord);
      helperTextarea?.removeEventListener("blur", handleBlurForChord);
      for (const eventName of focusOwnershipInputEvents) {
        helperTextarea?.removeEventListener(eventName, handleInputForFocusOwnership);
      }
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
      nativeCursorVisibilityRef.current = null;
      nativeCursorSuppression.dispose();
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
      setSyncOutputActive(false);
      if (paneId) {
        unregisterTerminalSerializer(paneId);
        unregisterTerminalInspector(paneId);
        unregisterTerminalScroller(paneId);
      }
      unregisterTerminalSerializer(instanceId);
      unregisterTerminalRenderCheckpointProvider(instanceId);
      unregisterTerminalInspector(instanceId);
      unregisterTerminalScroller(instanceId);
      unregisterAtlasRebuilder(instanceId);
      unlistenOutput?.();
      unlistenOutputV3?.();
      unlistenOutputFailStopped?.();
      closeTerminalSession(instanceId).catch(() => {});
      terminal.dispose();
      renderCheckpointModel.dispose();
      terminalParserAdmission.dispose();
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
  // Committed, not written during render. The shadow cursor is external state
  // shared with the xterm callbacks, so resetting it belongs to the commit that
  // actually put the new activity on screen. A layout effect still runs before
  // the overlay-caret repaint effect below (layout effects precede passive ones
  // in the same commit), which is the ordering the render-body write relied on.
  useLayoutEffect(() => {
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
    activityRef.current = activity;
  }, [activity]);
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
  const stabilizeInteractiveCursor = useSettingsStore((s) => {
    const prof = s.profiles?.find((p) => p.name === profile);
    return (
      prof?.stabilizeInteractiveCursor ??
      s.profileDefaults?.stabilizeInteractiveCursor ??
      defaultProfileDefaults.stabilizeInteractiveCursor
    );
  });
  // Overlay-caret inputs the xterm callbacks read synchronously. Committed for
  // the same reason as the mirrors above, and still ahead of the passive effect
  // that repaints the caret on these very values.
  useLayoutEffect(() => {
    overlayCursorShapeRef.current = overlayCursorShape;
    stabilizeInteractiveCursorRef.current = stabilizeInteractiveCursor;
  }, [overlayCursorShape, stabilizeInteractiveCursor]);
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
  const runTerminalRendererReflow = useCallback((_term: Terminal, syncBackendResize = false) => {
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
  }, []);
  useLayoutEffect(() => {
    const wasActive = remoteControlActiveRef.current;
    const remoteWasReleased =
      remoteControlReleaseRevisionRef.current !== remoteControlSnapshot.releaseRevision;
    remoteControlReleaseRevisionRef.current = remoteControlSnapshot.releaseRevision;
    const statusKnown = remoteControlStatus !== null;
    const remoteActive = remoteControlStatus?.active ?? false;
    remoteControlStatusKnownRef.current = statusKnown;
    remoteControlActiveRef.current = remoteActive;
    localControlAvailableRef.current = statusKnown && !remoteActive;

    const term = terminalRef.current;
    if (term) term.options.disableStdin = !statusKnown || remoteActive;
    if (
      !statusKnown ||
      remoteActive ||
      (!wasActive && !remoteWasReleased) ||
      !term ||
      !openedRef.current
    ) {
      return;
    }
    if (isContainerHiddenRef.current) {
      reflowDirtyRef.current = true;
      remoteReturnResizeDirtyRef.current = true;
      return;
    }
    runTerminalRendererReflow(term, true);
  }, [remoteControlSnapshot.releaseRevision, remoteControlStatus, runTerminalRendererReflow]);
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
      // The theme is the user's, hidden or not. Repainting the cursor in the
      // background colour only hid it while the cell under it still had the
      // theme background, which a TUI painting SGR 48 breaks — it turned into a
      // dark block instead (issue #598). Suppression now happens at the renderer
      // gate, owned by `applyNativeCursorVisibility`.
      term.options.cursorInactiveStyle = inputMode === "composer" ? "none" : "outline";
      term.options.theme = resolvedTheme;
      term.options.fontSize = font.size;
      term.options.fontFamily = fontFamily;
      const cursorOptions = toXtermCursorOptions(cursorShape);
      term.options.cursorBlink = effectiveNativeCursorBlink;
      term.options.cursorStyle = cursorOptions.cursorStyle;
      if (cursorOptions.cursorWidth !== undefined) {
        term.options.cursorWidth = cursorOptions.cursorWidth;
      }
      if (cursorOptions.cursorWidth === undefined) {
        delete (term.options as { cursorWidth?: number }).cursorWidth;
      }
    } catch {
      /* xterm mock may not support options setter */
    }
  }, [currentSchemeName, colorSchemes, font, cursorShape, effectiveNativeCursorBlink, inputMode]);

  // Renderer-level native cursor suppression (issue #598). `nativeCursorHidden`
  // is deliberately *not* recomputed here: the real condition also covers an
  // in-flight IME composition, which lives in a ref the xterm callbacks own.
  // Splitting that condition across two writers is what §8.15/§8.16/§8.17 of
  // data-flow.md keep reporting as a vanished caret, so React only pokes the
  // single owner and the owner dedupes.
  // `terminalGeneration` is a dep because a new xterm arrives with a fresh gate
  // (`suppressed: false`) and a fresh dedupe baseline, and none of the other deps
  // change when the instance is replaced. Without it a profile/instance change
  // during composer mode — or Codex with `stabilizeInteractiveCursor` — leaves
  // the native cursor drawn under the overlay caret until the next inputMode /
  // activity transition, i.e. exactly the doubled caret this suppression exists
  // to remove.
  useEffect(() => {
    nativeCursorVisibilityRef.current?.();
  }, [inputMode, activity, stabilizeInteractiveCursor, terminalGeneration]);

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
  }, [font, runTerminalRendererReflow]);

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
  }, [runTerminalRendererReflow]);

  // Wheel sensitivity is a live xterm option: a settings change applies to the
  // running terminal without a restart, and does not touch layout.
  const scrollSensitivityForEffect = useSettingsStore((s) =>
    normalizeScrollSensitivity(s.terminal.scrollSensitivity, DEFAULT_SCROLL_SENSITIVITY),
  );
  const fastScrollSensitivityForEffect = useSettingsStore((s) =>
    normalizeScrollSensitivity(s.terminal.fastScrollSensitivity, DEFAULT_FAST_SCROLL_SENSITIVITY),
  );
  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.options) return;
    try {
      term.options.scrollSensitivity = scrollSensitivityForEffect;
      term.options.fastScrollSensitivity = fastScrollSensitivityForEffect;
    } catch {
      /* xterm mock may not support options setter */
    }
  }, [scrollSensitivityForEffect, fastScrollSensitivityForEffect]);

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
  // they do not overlap. The button is positioned relative to the pane edge, so
  // it clears the fixed right-edge slider width (see SCROLL_BTN_RIGHT_PX).
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
        className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${nativeCursorHidden ? "terminal-native-cursor-hidden" : ""} ${inputMode === "composer" ? "terminal-composer-active" : ""}`}
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
        <textarea
          ref={imeFocusRelayRef}
          data-testid={`terminal-ime-focus-relay-${instanceId}`}
          className="terminal-ime-focus-relay"
          tabIndex={-1}
          disabled
          aria-hidden
          aria-label="Terminal input focus relay"
          autoComplete="off"
          spellCheck={false}
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
        {outputFailStopReason && (
          <TerminalOutputStoppedBar
            terminalId={instanceId}
            reason={outputFailStopReason}
            title={t("terminal.outputStoppedTitle")}
            description={t("terminal.outputStoppedDescription")}
            restartLabel={t("terminal.restart")}
            onRestart={onRestart}
          />
        )}
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
            <ChevronDownIcon size={24} strokeWidth={3} />
          </button>
        )}
      </div>
      <TerminalInputComposer
        mode={inputMode}
        text={composerDraft.text}
        labels={{
          editor: t("terminal.composerEditor"),
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
