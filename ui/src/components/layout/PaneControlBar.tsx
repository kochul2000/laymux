import { useState, useMemo, useCallback, useRef, type ReactNode } from "react";
import { useSettingsStore, type ControlBarMode } from "@/stores/settings-store";
import { useResolvedKeybinding } from "@/lib/keybinding-registry";
import { useOverridesStore } from "@/stores/overrides-store";
import { useUiStore } from "@/stores/ui-store";
import type { ViewInstanceConfig, ViewType } from "@/stores/types";
import { PaneControlContext, type PaneInputModeToggle } from "./PaneControlContext";
import { useContainerSize } from "@/hooks/useContainerSize";
import { PaneNumberBadge } from "@/components/ui/PaneNumberBadge";
import { supportsCwdReceive, supportsCwdSend } from "@/lib/view-cwd-capability";
import { FloatingPaneControlMenu } from "./FloatingPaneControlMenu";
import {
  ColumnsIcon,
  DownloadIcon,
  EllipsisIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  KeyboardIcon,
  PencilIcon,
  PinIcon,
  RefreshIcon,
  RowsIcon,
  UploadIcon,
  XIcon,
} from "@/components/ui/icons";

/**
 * 컨트롤 바 표시 모드. 각 모드는 독립적이며 서브 상태를 갖지 않는다.
 * - hover: 마우스 hover 시 표시, idle/타이핑/패인이탈 시 숨김
 * - pinned: 항상 표시 (콘텐츠 위에 고정)
 * - minimized: 3-dot 버튼만 표시, 클릭 시 hover로 복귀
 *
 * ⚠️ 모드 내부에 "열림/닫힘" 같은 서브 상태를 절대 추가하지 말 것.
 *    모드 전환은 항상 setMode() 한번으로 완결되어야 한다.
 *
 * 기본 모드는 settings > convenience > defaultControlBarMode에서 설정.
 * per-pane 모드는 Pane 인스턴스 오버라이드(overrides-store, localStorage) 로 persist.
 */
export type { ControlBarMode } from "@/stores/settings-store";

export interface PaneControlBarActions {
  onSplitH?: () => void;
  onSplitV?: () => void;
  onRestart?: () => void;
  onClear?: () => void;
  onDelete?: () => void;
  onChangeView?: (config: ViewInstanceConfig) => void;
  onToggleCwdSend?: () => void;
  onToggleCwdReceive?: () => void;
  /** 1회성 CWD 전파 (issue #293). 현재 CWD 를 sync group 에 한 번 밀어넣는다. */
  onPropagateCwdOnce?: () => void;
}

interface PaneControlBarProps {
  /** Stable pane ID for persisting control bar mode across restarts. */
  paneId?: string;
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  hovered: boolean;
  /** False while a retained background workspace is display:none. */
  isActive?: boolean;
  /**
   * Effective CWD send/receive state for indicator display.
   *
   * Computed by the caller from `viewConfig.cwdSend ?? resolveSyncCwd(...)` so the
   * indicator stays in sync with what the backend actually applies. Do NOT fall back
   * to `currentView.cwdSend ?? true` here — that ignores `syncCwdDefaults` (default off)
   * and shows an "on" icon for a propagation that the backend treats as off.
   */
  cwdSendOn?: boolean;
  cwdReceiveOn?: boolean;
  /** 화면 읽기 순서 기반 pane 번호(issue #256). 컨트롤바 좌측에 배지로 표시. */
  paneNumber?: number;
  /**
   * 배지 클릭 시 복사할 pane 식별자에 포함할 workspace 정보(issue #276).
   * `workspaceId`가 있어야 배지가 클릭-복사 가능해진다.
   */
  workspaceId?: string;
  workspaceName?: string;
  /**
   * pane 위치 교환 드래그 활성화(issue #377, 재설계 #386). 활성 시 컨트롤 바의
   * 버튼 없는 빈 영역을 드래그하면 pane swap DnD 가 시작된다(별도 핸들 없음).
   */
  dndEnabled?: boolean;
  /** 빈 영역 드래그 시작 핸들러(paneId 는 PaneGrid 가 클로저로 주입). */
  onPaneDragStart?: (e: React.DragEvent) => void;
  /** 드래그 종료 핸들러. */
  onPaneDragEnd?: () => void;
  /**
   * workspace selector 목록 숨김 토글 노출 여부 (ADR-0035). pane 숨김은 보관함이
   * 아니라 각 pane 의 이 토글로만 제어한다. dock pane 은 selector 에 나오지 않으므로
   * PaneGrid 가 location === "workspace" 일 때만 켠다.
   */
  showListHideToggle?: boolean;
  children: React.ReactNode;
}

// ─── Design tokens ───────────────────────────────────────
const BAR_H = "var(--bar-h)";
const BTN_H = "var(--btn-h)";
const BTN_MIN_W = "var(--btn-min-w)";
const barBg = "var(--bg-surface)";
const borderClr = "var(--border)";
const sepClr = "var(--separator-bg)";

// ─── Shared Button ───────────────────────────────────────
function BarBtn({
  children,
  onClick,
  title,
  active,
  danger,
  testId,
  style,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  danger?: boolean;
  testId?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      className="hover-bg-strong flex shrink-0 cursor-pointer items-center justify-center rounded px-0 text-[11px]"
      style={{
        height: BTN_H,
        minWidth: BTN_MIN_W,
        color: danger ? "var(--red)" : active ? "var(--accent)" : "var(--text-secondary)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        transition: "background var(--transition-fast)",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="ui-sep" />;
}

// ─── Terminal input-mode toggle (direct ↔ composer) ─────
// 단일 버튼으로 현재 모드 아이콘을 보여주고 클릭 시 반대 모드로 전환한다.
// composer 활성 시 accent 로 강조. 단축키(terminal.toggleInputMode)는 별도.
function InputModeToggleBtn({ toggle }: { toggle: PaneInputModeToggle }) {
  const composer = toggle.mode === "composer";
  return (
    <BarBtn
      testId="pane-control-input-mode"
      onClick={toggle.onToggle}
      active={composer}
      title={
        composer
          ? "Composer input — switch to Direct (Ctrl+Alt+M)"
          : "Direct input — switch to Composer (Ctrl+Alt+M)"
      }
    >
      {composer ? <PencilIcon /> : <KeyboardIcon />}
    </BarBtn>
  );
}

// ─── Propagate CWD once (issue #293 → #324) ─────────────
// 우측 컨트롤 묶음이 아니라 좌측(pane 번호 배지 우측)에 정렬된다.
// 단축키(pane.propagateCwdOnce, 기본 Ctrl+Alt+P)는 useKeyboardShortcuts 가 처리한다.
// 훅으로 settings store 를 구독하므로 재바인딩 시 부모 useMemo 와 무관하게
// 이 컴포넌트 스스로 리렌더되어 툴팁이 갱신된다 (PR #331 리뷰).
function PropagateCwdOnceBtn({ onClick }: { onClick: () => void }) {
  const keys = useResolvedKeybinding("pane.propagateCwdOnce");
  return (
    <BarBtn
      testId="pane-control-cwd-propagate-once"
      onClick={onClick}
      title={`Propagate CWD once${keys ? ` (${keys})` : ""}`}
    >
      <UploadIcon />
    </BarBtn>
  );
}

// ─── View selector ──────────────────────────────────────
function ViewSelect({
  currentView,
  onChange,
}: {
  currentView: ViewInstanceConfig;
  onChange: (config: ViewInstanceConfig) => void;
}) {
  const profiles = useSettingsStore((s) => s.profiles);
  const visibleProfiles = profiles.filter((p) => !p.hidden);

  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const effectiveProfile =
    currentView.type === "TerminalView"
      ? (currentView.profile as string) || defaultProfile || visibleProfiles[0]?.name || ""
      : "";
  // Extra CLAUDE_CONFIG_DIRs are offered as sibling options, so switching the
  // monitored account is the same gesture as switching a terminal profile.
  const usageConfigDirs = useSettingsStore((s) => s.usage.claude.configDirs);
  const usageConfigDir =
    currentView.type === "UsageView" ? (currentView.configDir as string) || "" : "";
  const codexUsageConfigDirs = useSettingsStore((s) => s.usage.codex.configDirs);
  const codexUsageConfigDir =
    currentView.type === "CodexUsageView" ? (currentView.configDir as string) || "" : "";
  const grokUsageConfigDirs = useSettingsStore((s) => s.usage.grok.configDirs);
  const grokUsageConfigDir =
    currentView.type === "GrokUsageView" ? (currentView.configDir as string) || "" : "";

  const value =
    currentView.type === "TerminalView"
      ? `TerminalView:${effectiveProfile}`
      : currentView.type === "UsageView"
        ? `UsageView:${usageConfigDir}`
        : currentView.type === "CodexUsageView"
          ? `CodexUsageView:${codexUsageConfigDir}`
          : currentView.type === "GrokUsageView"
            ? `GrokUsageView:${grokUsageConfigDir}`
            : currentView.type;

  return (
    <select
      data-testid="pane-control-view-select"
      value={value}
      onChange={(e) => {
        const val = e.target.value;
        // A native select keeps DOM focus after committing an option. The pane
        // remains logically focused, so a same-pane profile swap would not
        // trigger the view's `isFocused` effect and keyboard input could stay
        // parked on this selector instead of the newly created terminal.
        e.currentTarget.blur();
        if (val.startsWith("TerminalView:")) {
          onChange({ type: "TerminalView", profile: val.slice("TerminalView:".length) });
        } else if (val.startsWith("UsageView:")) {
          onChange({ type: "UsageView", configDir: val.slice("UsageView:".length) });
        } else if (val.startsWith("CodexUsageView:")) {
          onChange({ type: "CodexUsageView", configDir: val.slice("CodexUsageView:".length) });
        } else if (val.startsWith("GrokUsageView:")) {
          onChange({ type: "GrokUsageView", configDir: val.slice("GrokUsageView:".length) });
        } else {
          onChange({ type: val as ViewType });
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer rounded text-[11px] font-medium"
      style={{
        height: BTN_H,
        padding: "0 6px",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
        border: `1px solid ${sepClr}`,
        borderRadius: "var(--radius-sm)",
        outline: "none",
        maxWidth: 110,
        colorScheme: "dark",
      }}
    >
      <option value="EmptyView">Empty</option>
      {visibleProfiles.map((p) => (
        <option key={p.name} value={`TerminalView:${p.name}`}>
          {p.name}
        </option>
      ))}
      <option value="MemoView">Memo</option>
      <option value="UsageView:">Claude Usage</option>
      <option value="CodexUsageView:">Codex Usage</option>
      <option value="GrokUsageView:">Grok Usage</option>
      {usageConfigDirs.map((dir) => (
        <option key={dir} value={`UsageView:${dir}`}>
          Usage: {dir}
        </option>
      ))}
      {codexUsageConfigDirs.map((dir) => (
        <option key={dir} value={`CodexUsageView:${dir}`}>
          Codex: {dir}
        </option>
      ))}
      {grokUsageConfigDirs.map((dir) => (
        <option key={dir} value={`GrokUsageView:${dir}`}>
          Grok: {dir}
        </option>
      ))}
      <option value="GitHubView">GitHub</option>
      <option value="IssueReporterView">Issue Reporter</option>
    </select>
  );
}

// ─── Bar content (shared by hover & pinned modes) ───────
function BarContent({
  currentView,
  actions,
  mode,
  onSetMode,
  cwdSendOn,
  cwdReceiveOn,
  inputModeToggle,
  paneHidden,
  onToggleHidden,
  expanded = true,
  wrapped = false,
  showPin = true,
  showMinimize = true,
  testId,
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  onSetMode: (m: ControlBarMode) => void;
  cwdSendOn?: boolean;
  cwdReceiveOn?: boolean;
  inputModeToggle?: PaneInputModeToggle | null;
  /** workspace selector 목록 숨김 여부(토글 표시 상태). */
  paneHidden?: boolean;
  /** 있으면 목록 숨김 토글 버튼을 렌더한다 (ADR-0035). */
  onToggleHidden?: () => void;
  expanded?: boolean;
  wrapped?: boolean;
  showPin?: boolean;
  showMinimize?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex shrink-0 items-center gap-0.5 ${
        wrapped
          ? "w-full min-w-0 max-w-full flex-wrap [justify-content:safe_flex-end]"
          : "justify-end"
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      {expanded && (
        <>
          {inputModeToggle && (
            <>
              <InputModeToggleBtn toggle={inputModeToggle} />
              <Sep />
            </>
          )}
          {actions.onChangeView && (
            <ViewSelect currentView={currentView} onChange={actions.onChangeView} />
          )}

          {supportsCwdSend(currentView.type) &&
            actions.onToggleCwdSend &&
            (() => {
              // Effective state must come from the caller (resolveSyncCwd + per-pane override).
              // Falling back to `currentView.cwdSend ?? true` here lies about the actual
              // propagation state when no per-pane override exists and the default is off.
              const isOn = cwdSendOn ?? false;
              return (
                <>
                  <Sep />
                  <BarBtn
                    testId="pane-control-cwd-send"
                    onClick={actions.onToggleCwdSend}
                    title={isOn ? "CWD Send (on)" : "CWD Send (off)"}
                    active={isOn}
                    style={isOn ? undefined : { opacity: 0.4 }}
                  >
                    <UploadIcon />
                  </BarBtn>
                </>
              );
            })()}
          {supportsCwdReceive(currentView.type) &&
            actions.onToggleCwdReceive &&
            (() => {
              const isOn = cwdReceiveOn ?? false;
              return (
                <BarBtn
                  testId="pane-control-cwd-receive"
                  onClick={actions.onToggleCwdReceive}
                  title={isOn ? "CWD Receive (on)" : "CWD Receive (off)"}
                  active={isOn}
                  style={isOn ? undefined : { opacity: 0.4 }}
                >
                  <DownloadIcon />
                </BarBtn>
              );
            })()}

          {actions.onSplitH && (
            <BarBtn
              testId="pane-control-split-h"
              onClick={actions.onSplitH}
              title="Split horizontal"
            >
              <RowsIcon />
            </BarBtn>
          )}
          {actions.onSplitV && (
            <BarBtn testId="pane-control-split-v" onClick={actions.onSplitV} title="Split vertical">
              <ColumnsIcon />
            </BarBtn>
          )}
          {onToggleHidden && (
            <BarBtn
              testId="pane-control-hide"
              onClick={onToggleHidden}
              title={paneHidden ? "Show in workspace list" : "Hide from workspace list"}
              active={paneHidden}
            >
              {paneHidden ? <EyeOffIcon /> : <EyeIcon />}
            </BarBtn>
          )}
          {currentView.type === "TerminalView" && actions.onRestart && (
            <BarBtn
              testId="pane-control-restart"
              onClick={actions.onRestart}
              title="Restart view"
              danger
            >
              <RefreshIcon size={13} />
            </BarBtn>
          )}
          {actions.onClear && (
            <BarBtn testId="pane-control-clear" onClick={actions.onClear} title="Clear view" danger>
              <EraserIcon size={13} />
            </BarBtn>
          )}
          {actions.onDelete && (
            <BarBtn
              testId="pane-control-delete"
              onClick={actions.onDelete}
              title="Delete pane"
              danger
            >
              <XIcon size={12} />
            </BarBtn>
          )}

          <Sep />
        </>
      )}

      {showPin && (
        <BarBtn
          testId="pane-control-pin"
          onClick={() => onSetMode(mode === "pinned" ? "hover" : "pinned")}
          title={mode === "pinned" ? "Unpin" : "Pin"}
          active={mode === "pinned"}
        >
          <PinIcon size={12} />
        </BarBtn>
      )}
      {showMinimize && (
        <BarBtn
          testId="pane-control-minimize"
          onClick={() => onSetMode("minimized")}
          title="Minimize"
        >
          <EllipsisIcon size={12} />
        </BarBtn>
      )}
    </div>
  );
}

/**
 * 좁은 pane 의 ⋯ 트리거 버튼. 메뉴 자체는 PaneControlBar 루트에서 portal 로 렌더한다
 * (issue #384) — 버튼만 바 안에 두어 위치 측정 기준점(buttonRef)을 제공한다.
 */
function FloatingControlAnchor({
  menuOpen,
  onToggleMenu,
  buttonRef,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** 콜백 ref — 트리거가 어느 바에서 렌더되든 살아 있는 노드 하나만 추적한다. */
  buttonRef: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        data-testid="pane-control-menu-btn"
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
        className="hover-bg-strong flex cursor-pointer items-center justify-center rounded"
        style={{
          width: BTN_MIN_W,
          height: BTN_MIN_W,
          background: "var(--backdrop-light)",
          color: "var(--text-secondary)",
          border: `1px solid ${borderClr}`,
          borderRadius: "var(--radius-sm)",
          transition: "background var(--transition-fast)",
        }}
        title="Pane controls"
      >
        <EllipsisIcon size={12} />
      </button>
    </div>
  );
}

/** Minimized: just a small button that expands the full bar on click. */
function MinimizedButton({ onExpand }: { onExpand: () => void }) {
  return (
    <div
      className="absolute right-0.5 top-0 z-20 flex items-center"
      style={{ height: BAR_H }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        data-testid="pane-control-menu-btn"
        onClick={onExpand}
        className="hover-bg-strong flex cursor-pointer items-center justify-center rounded"
        style={{
          width: BTN_MIN_W,
          height: BTN_MIN_W,
          background: "var(--backdrop-light)",
          color: "var(--text-secondary)",
          border: `1px solid ${borderClr}`,
          borderRadius: "var(--radius-sm)",
          transition: "background var(--transition-fast)",
        }}
        title="Expand control bar"
      >
        <EllipsisIcon size={12} />
      </button>
    </div>
  );
}

// ─── View label map ─────────────────────────────────────
const VIEW_LABELS: Partial<Record<ViewType, string>> = {
  EmptyView: "Empty",
  MemoView: "Memo",
  UsageView: "Claude Usage",
  CodexUsageView: "Codex Usage",
  GrokUsageView: "Grok Usage",
  IssueReporterView: "Issue Reporter",
  FileExplorerView: "File Explorer",
  GitHubView: "GitHub",
};

// ─── Bar left section (view label) ──────────────────────
function BarLabel({ viewType }: { viewType: ViewType }) {
  const label = VIEW_LABELS[viewType] ?? null;
  if (!label) return <div className="flex-1" />;
  return (
    <div className="flex min-w-0 flex-1 items-center self-stretch text-[11px]">
      <span className="ui-toolbar-title" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────
/**
 * 바 컨테이너에 적용할 draggable 속성을 만든다(issue #386).
 *
 * 빈 영역(바 배경)에서 시작한 드래그만 pane swap 으로 처리한다. 버튼/select 등
 * 인터랙티브 요소 위에서 시작한 드래그는 `e.target !== e.currentTarget` 으로 걸러
 * preventDefault 하여 무시한다 — 그래야 버튼 클릭/포커스가 정상 동작한다.
 * dndEnabled 가 아니면 빈 객체를 돌려줘 평소 렌더와 동일하다.
 */
function barDragProps(
  dndEnabled: boolean | undefined,
  onPaneDragStart: ((e: React.DragEvent) => void) | undefined,
  onPaneDragEnd: (() => void) | undefined,
): { draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void } {
  if (!dndEnabled || !onPaneDragStart) return {};
  return {
    draggable: true,
    onDragStart: (e) => {
      if (e.target !== e.currentTarget) {
        // 버튼/select 등 자식 위에서 시작 → 드래그 개시 취소(클릭 정상 유지).
        e.preventDefault();
        return;
      }
      onPaneDragStart(e);
    },
    onDragEnd: onPaneDragEnd,
  };
}

export function PaneControlBar({
  paneId,
  currentView,
  actions,
  hovered,
  isActive = true,
  cwdSendOn,
  cwdReceiveOn,
  paneNumber,
  workspaceId,
  workspaceName,
  dndEnabled,
  onPaneDragStart,
  onPaneDragEnd,
  showListHideToggle,
  children,
}: PaneControlBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // workspace selector 목록 숨김 상태(raw)를 구독해 토글 버튼 상태로 쓴다 (ADR-0035).
  const paneHidden = useUiStore((s) =>
    showListHideToggle && paneId ? s.hiddenPaneIds.has(paneId) : false,
  );
  const onToggleHidden = useMemo(
    () =>
      showListHideToggle && paneId
        ? () => useUiStore.getState().togglePaneHidden(paneId)
        : undefined,
    [showListHideToggle, paneId],
  );
  const { w: paneWidth } = useContainerSize(rootRef);
  const persistedMode = useOverridesStore((s) =>
    paneId ? s.paneOverrides[paneId]?.controlBarMode : undefined,
  );
  const defaultMode = useSettingsStore((s) => s.controlBar.defaultMode);
  const setPaneOverride = useOverridesStore((s) => s.setPaneOverride);
  // Local fallback for components rendered without a paneId (tests, previews) —
  // keeps toggling functional but doesn't persist anywhere.
  const [localMode, setLocalMode] = useState<ControlBarMode | undefined>(undefined);
  const mode: ControlBarMode = paneId ? (persistedMode ?? defaultMode) : (localMode ?? defaultMode);
  const setMode = useCallback(
    (m: ControlBarMode) => {
      if (paneId) setPaneOverride(paneId, { controlBarMode: m });
      else setLocalMode(m);
    },
    [paneId, setPaneOverride],
  );
  const [hasViewHeader, setHasViewHeader] = useState(false);
  const [headerControlsOverflow, setHeaderControlsOverflow] = useState(false);
  const [leftBarContent, setLeftBarContentState] = useState<ReactNode>(null);
  const [inputModeToggle, setInputModeToggleState] = useState<PaneInputModeToggle | null>(null);
  const [floatingMenuReason, setFloatingMenuReason] = useState<"manual" | "hover" | null>(null);
  const showBar = mode === "pinned" || (mode === "hover" && hovered);
  const isPinned = mode === "pinned";
  const narrowBar = paneWidth > 0 && paneWidth < 360;
  const floatingControls =
    isActive && mode !== "minimized" && (narrowBar || headerControlsOverflow);

  // 좁은 pane 또는 ViewHeader 충돌의 떠 있는 컨트롤 메뉴. ⋯ anchor는 어느
  // 바에 있든(pinned / hover / ViewHeader) 하나의 ref 로 위치 기준점을 공유한다.
  // 메뉴 자체는 컴포넌트 루트에서 portal 로 한 번만 렌더해 pane hover 생명주기와 분리한다.
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  // 정상 상태에선 트리거가 한 개지만, View 가 자체 헤더를 등록하는 전환(예: 좁은 pane 을
  // UsageView 로 바꿀 때)에는 pane 바와 ViewHeader 의 트리거가 한 커밋 동안 함께 마운트된다.
  // 이어서 pane 바가 사라질 때의 detach 가 살아 있는 ViewHeader 트리거까지 지우면 위치
  // 측정이 실패해 메뉴가 pane 이 아니라 앱 화면 우상단에 붙는다. React 19 의 콜백 ref
  // cleanup 으로 "지금 들고 있는 노드가 나일 때만" 비운다.
  // cleanup 을 반환하므로 React 19 는 이 콜백을 null 로 호출하지 않는다. 그래도 시그니처는
  // RefCallback 그대로 두고 null 을 무시한다 — 레거시 호출 규약으로 떨어지더라도 살아 있는
  // 트리거를 지우지 않는 쪽이 안전하다(측정 실패 시엔 아래 pane 폴백이 받는다).
  const setMenuBtnRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    menuBtnRef.current = node;
    return () => {
      if (menuBtnRef.current === node) menuBtnRef.current = null;
    };
  }, []);
  const closeFloatingMenu = useCallback(() => setFloatingMenuReason(null), []);
  const toggleFloatingMenu = useCallback(() => {
    // Clicking an automatically opened hover toolbar makes it explicit instead
    // of closing it under the pointer. A second click closes the manual menu.
    setFloatingMenuReason((reason) => (reason === "manual" ? null : "manual"));
  }, []);
  const openControls = useCallback((reason: "manual" | "hover" = "manual") => {
    setFloatingMenuReason((current) => (current === "manual" ? current : reason));
  }, []);
  // When no responsive rule needs the anchor anymore, discard stale open state
  // so a later resize cannot resurrect an old menu.
  if (!floatingControls && floatingMenuReason) setFloatingMenuReason(null);
  const floatingMenuVisible = floatingControls && floatingMenuReason != null;

  // pane swap 드래그 속성(issue #386). 현재 보이는 바 컨테이너(pinned/hover/ViewHeader)에
  // 동일하게 적용한다. 빈 영역에서 시작한 드래그만 swap 으로 처리(아래 헬퍼 참조).
  const dragProps = useMemo(
    () => barDragProps(dndEnabled, onPaneDragStart, onPaneDragEnd),
    [dndEnabled, onPaneDragStart, onPaneDragEnd],
  );

  // 모든 모드에서 children을 동일한 DOM 위치에 유지하여
  // pin/unpin 전환 시 React가 children을 리마운트하지 않도록 한다.
  const modeTestId =
    mode === "minimized"
      ? "pane-control-minimized"
      : isPinned
        ? "pane-control-pinned"
        : "pane-control-hover";

  const hasBarLabel = currentView.type !== "TerminalView" && currentView.type !== "EmptyView";

  // 1회성 CWD 전파 버튼 (issue #293) — 좌측, pane 번호 배지 우측에 정렬 (issue #324).
  const showPropagateCwd = supportsCwdSend(currentView.type) && actions.onPropagateCwdOnce != null;
  const leftPaneControls = useMemo(
    () =>
      showPropagateCwd && actions.onPropagateCwdOnce ? (
        <PropagateCwdOnceBtn onClick={actions.onPropagateCwdOnce} />
      ) : null,
    [showPropagateCwd, actions.onPropagateCwdOnce],
  );

  // 좌측 아이콘(pane 번호 배지 + propagate 버튼)을 한 컨테이너로 묶는다. 우측 컨트롤과
  // 동일하게 바 오버레이(issue #320: 평소 반투명, hover 시 불투명)를 그대로 따른다 —
  // 별도 불투명 배경 칩을 두지 않아 좌/우 아이콘이 같은 방식으로 보인다.
  // 좌측 아이콘이 하나도 없으면 컨테이너 자체를 렌더하지 않는다.
  const hasLeftIcons = paneNumber != null || showPropagateCwd;
  const leftIcons = hasLeftIcons ? (
    <div data-testid="pane-control-bar-left-solid" className="flex shrink-0 items-center">
      <PaneNumberBadge
        number={paneNumber}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
      />
      {leftPaneControls}
    </div>
  ) : null;

  // 자식(TerminalView 등)이 주입한 좌측 콘텐츠가 있으면 기본 BarLabel 대신 사용.
  // 둘 다 없으면 flex-1 스페이서만 렌더하여 pane 컨트롤이 오른쪽 끝에 정렬되도록 한다.
  const hasLeftContent =
    hasBarLabel || leftBarContent != null || paneNumber != null || showPropagateCwd;

  const paneControls = useMemo(
    () =>
      floatingControls ? (
        <FloatingControlAnchor
          menuOpen={floatingMenuReason != null}
          onToggleMenu={toggleFloatingMenu}
          buttonRef={setMenuBtnRef}
        />
      ) : (
        <BarContent
          currentView={currentView}
          actions={actions}
          mode={mode}
          onSetMode={setMode}
          cwdSendOn={cwdSendOn}
          cwdReceiveOn={cwdReceiveOn}
          inputModeToggle={inputModeToggle}
          paneHidden={paneHidden}
          onToggleHidden={onToggleHidden}
        />
      ),
    [
      currentView,
      actions,
      mode,
      setMode,
      floatingControls,
      floatingMenuReason,
      toggleFloatingMenu,
      setMenuBtnRef,
      cwdSendOn,
      cwdReceiveOn,
      inputModeToggle,
      paneHidden,
      onToggleHidden,
    ],
  );

  const registerHeader = useCallback(() => setHasViewHeader(true), []);
  const unregisterHeader = useCallback(() => {
    setHasViewHeader(false);
    setHeaderControlsOverflow(false);
  }, []);
  const reportHeaderControlsOverflow = useCallback((overflow: boolean) => {
    setHeaderControlsOverflow(overflow);
  }, []);
  const setLeftBarContent = useCallback((node: ReactNode) => {
    setLeftBarContentState(node ?? null);
  }, []);
  const setInputModeToggle = useCallback((toggle: PaneInputModeToggle | null) => {
    setInputModeToggleState(toggle);
  }, []);

  const ctxValue = useMemo(
    () => ({
      paneControls,
      leftPaneControls,
      mode,
      floatingControls,
      reportHeaderControlsOverflow,
      hovered,
      onSetMode: setMode,
      openControls,
      registerHeader,
      unregisterHeader,
      leftBarContent,
      setLeftBarContent,
      inputModeToggle,
      setInputModeToggle,
      paneNumber,
      workspaceId,
      workspaceName,
      barDragProps: dragProps,
    }),
    [
      paneControls,
      leftPaneControls,
      mode,
      floatingControls,
      reportHeaderControlsOverflow,
      hovered,
      setMode,
      openControls,
      registerHeader,
      unregisterHeader,
      leftBarContent,
      setLeftBarContent,
      inputModeToggle,
      setInputModeToggle,
      paneNumber,
      workspaceId,
      workspaceName,
      dragProps,
    ],
  );

  return (
    <PaneControlContext.Provider value={ctxValue}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="flex h-full w-full min-w-0 flex-col overflow-hidden"
        data-testid={modeTestId}
      >
        {/* Pinned bar: ViewHeader가 없는 View만 자체 바 렌더 */}
        {isPinned && !hasViewHeader && (
          <div
            data-testid="pane-control-bar"
            className="ui-toolbar relative shrink-0 pl-2 pr-1"
            style={{
              background: barBg,
              borderBottom: `1px solid ${borderClr}`,
            }}
            {...dragProps}
          >
            {leftIcons}
            {hasBarLabel ? (
              <BarLabel viewType={currentView.type} />
            ) : leftBarContent ? (
              <div
                data-testid="pane-control-bar-left"
                className="flex min-w-0 flex-1 items-center self-stretch"
              >
                {leftBarContent}
              </div>
            ) : (
              <div className="flex-1" />
            )}
            {narrowBar ? (
              <FloatingControlAnchor
                menuOpen={floatingMenuReason != null}
                onToggleMenu={toggleFloatingMenu}
                buttonRef={setMenuBtnRef}
              />
            ) : (
              <BarContent
                currentView={currentView}
                actions={actions}
                mode={mode}
                onSetMode={setMode}
                cwdSendOn={cwdSendOn}
                cwdReceiveOn={cwdReceiveOn}
                inputModeToggle={inputModeToggle}
                paneHidden={paneHidden}
                onToggleHidden={onToggleHidden}
              />
            )}
          </div>
        )}

        {/* children은 항상 이 위치에 렌더링 — 모드 전환으로 리마운트되지 않음 */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}

          {/* Hover bar: ViewHeader가 없는 View만 overlay */}
          {!isPinned && !hasViewHeader && mode !== "minimized" && showBar && (
            <div
              data-testid="pane-control-bar"
              className={`pane-hover-bar absolute top-0 z-20 flex items-center pr-1 ${
                hasLeftContent || narrowBar ? "left-0 right-0 pl-2" : "right-0 pl-0.5"
              }`}
              style={{
                minHeight: BAR_H,
                borderBottom: `1px solid ${sepClr}`,
                ...(!hasLeftContent && !narrowBar ? { borderLeft: `1px solid ${sepClr}` } : {}),
                borderRadius: 0,
              }}
              {...dragProps}
            >
              {leftIcons}
              {hasBarLabel ? (
                <BarLabel viewType={currentView.type} />
              ) : leftBarContent ? (
                <div
                  data-testid="pane-control-bar-left"
                  className="flex min-w-0 flex-1 items-center self-stretch"
                >
                  {leftBarContent}
                </div>
              ) : (
                // 배지만 있고 좌측 콘텐츠가 없을 때도 pinned 바와 동일하게
                // flex-1 스페이서로 컨트롤을 오른쪽 끝에 정렬한다.
                <div className="flex-1" />
              )}
              {narrowBar ? (
                <FloatingControlAnchor
                  menuOpen={floatingMenuReason != null}
                  onToggleMenu={toggleFloatingMenu}
                  buttonRef={setMenuBtnRef}
                />
              ) : (
                <BarContent
                  currentView={currentView}
                  actions={actions}
                  mode={mode}
                  onSetMode={setMode}
                  cwdSendOn={cwdSendOn}
                  cwdReceiveOn={cwdReceiveOn}
                  inputModeToggle={inputModeToggle}
                  paneHidden={paneHidden}
                  onToggleHidden={onToggleHidden}
                />
              )}
            </div>
          )}

          {/* Minimized: ViewHeader가 없는 View만 3-dot 버튼 */}
          {mode === "minimized" && !hasViewHeader && hovered && (
            <MinimizedButton
              onExpand={() => {
                setMode("hover");
                if (narrowBar) {
                  setFloatingMenuReason("manual");
                }
              }}
            />
          )}
        </div>

        {/* 좁은 pane 또는 ViewHeader 충돌의 floating toolbar: pane의
            overflow/stacking context 밖으로 portal 되어 작업영역 크기를 바꾸지 않는다. */}
        {floatingMenuVisible && (
          <FloatingPaneControlMenu
            openReason={floatingMenuReason!}
            ownerHovered={hovered}
            onRequestClose={closeFloatingMenu}
            triggerRef={menuBtnRef}
            paneRef={rootRef}
          >
            <BarContent
              currentView={currentView}
              actions={actions}
              mode={mode}
              onSetMode={setMode}
              cwdSendOn={cwdSendOn}
              cwdReceiveOn={cwdReceiveOn}
              inputModeToggle={inputModeToggle}
              paneHidden={paneHidden}
              onToggleHidden={onToggleHidden}
              wrapped
              testId="pane-control-floating-content"
            />
          </FloatingPaneControlMenu>
        )}
      </div>
    </PaneControlContext.Provider>
  );
}
