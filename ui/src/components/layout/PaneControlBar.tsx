import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettingsStore, type ControlBarMode } from "@/stores/settings-store";
import { useResolvedKeybinding } from "@/lib/keybinding-registry";
import { useOverridesStore } from "@/stores/overrides-store";
import type { ViewInstanceConfig, ViewType } from "@/stores/types";
import { PaneControlContext, type PaneInputModeToggle } from "./PaneControlContext";
import { useContainerSize } from "@/hooks/useContainerSize";
import { PaneNumberBadge } from "@/components/ui/PaneNumberBadge";

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
      {composer ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17v3z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M13.5 8.5l2.5 2.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <rect
            x="2.5"
            y="6"
            width="19"
            height="12"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M7 10h.01M11 10h.01M15 10h.01M8.5 14h7"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )}
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
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 2v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path
          d="M4 5l3-3 3 3Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
          fill="currentColor"
        />
        <path
          d="M3 9.5a4 4 0 1 0 8 0"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </BarBtn>
  );
}

function VerticalSep() {
  return <div className="my-1 h-px w-4 shrink-0" style={{ background: sepClr }} />;
}

// ─── View selector ──────────────────────────────────────
function ViewSelect({
  currentView,
  onChange,
  compact = false,
}: {
  currentView: ViewInstanceConfig;
  onChange: (config: ViewInstanceConfig) => void;
  compact?: boolean;
}) {
  const profiles = useSettingsStore((s) => s.profiles);
  const visibleProfiles = profiles.filter((p) => !p.hidden);

  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const effectiveProfile =
    currentView.type === "TerminalView"
      ? (currentView.profile as string) || defaultProfile || visibleProfiles[0]?.name || ""
      : "";
  const value =
    currentView.type === "TerminalView" ? `TerminalView:${effectiveProfile}` : currentView.type;

  return (
    <select
      data-testid="pane-control-view-select"
      value={value}
      onChange={(e) => {
        const val = e.target.value;
        if (val.startsWith("TerminalView:")) {
          onChange({ type: "TerminalView", profile: val.slice("TerminalView:".length) });
        } else {
          onChange({ type: val as ViewType });
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer rounded text-[11px] font-medium"
      style={{
        height: BTN_H,
        width: compact ? BTN_MIN_W : undefined,
        padding: compact ? "0 2px" : "0 6px",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
        border: `1px solid ${sepClr}`,
        borderRadius: "var(--radius-sm)",
        outline: "none",
        maxWidth: compact ? BTN_MIN_W : 110,
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
  expanded = true,
  wrapped = false,
  vertical = false,
  showPin = true,
  showMinimize = true,
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  onSetMode: (m: ControlBarMode) => void;
  cwdSendOn?: boolean;
  cwdReceiveOn?: boolean;
  inputModeToggle?: PaneInputModeToggle | null;
  expanded?: boolean;
  wrapped?: boolean;
  vertical?: boolean;
  showPin?: boolean;
  showMinimize?: boolean;
}) {
  const Separator = vertical ? VerticalSep : Sep;

  return (
    <div
      className={
        vertical
          ? "flex shrink-0 flex-col items-center justify-start gap-0.5"
          : `flex shrink-0 items-center justify-end gap-0.5 ${wrapped ? "max-w-[124px] flex-wrap" : ""}`
      }
      onClick={(e) => e.stopPropagation()}
    >
      {expanded && (
        <>
          {inputModeToggle && (
            <>
              <InputModeToggleBtn toggle={inputModeToggle} />
              <Separator />
            </>
          )}
          {actions.onChangeView && (
            <ViewSelect
              currentView={currentView}
              onChange={actions.onChangeView}
              compact={vertical}
            />
          )}

          {(currentView.type === "TerminalView" || currentView.type === "FileExplorerView") &&
            actions.onToggleCwdSend &&
            (() => {
              // Effective state must come from the caller (resolveSyncCwd + per-pane override).
              // Falling back to `currentView.cwdSend ?? true` here lies about the actual
              // propagation state when no per-pane override exists and the default is off.
              const isOn = cwdSendOn ?? false;
              return (
                <>
                  <Separator />
                  <BarBtn
                    testId="pane-control-cwd-send"
                    onClick={actions.onToggleCwdSend}
                    title={isOn ? "CWD Send (on)" : "CWD Send (off)"}
                    active={isOn}
                    style={isOn ? undefined : { opacity: 0.4 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M4 5l3-3 3 3Z"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinejoin="round"
                        fill={isOn ? "currentColor" : "none"}
                      />
                      <path
                        d="M7 5v5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                      <path
                        d="M3 12h8"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </BarBtn>
                </>
              );
            })()}
          {(currentView.type === "TerminalView" || currentView.type === "FileExplorerView") &&
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
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M4 7l3 3 3-3Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                      fill={isOn ? "currentColor" : "none"}
                    />
                    <path
                      d="M7 2v5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                    <path
                      d="M3 12h8"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </BarBtn>
              );
            })()}

          {actions.onSplitH && (
            <BarBtn
              testId="pane-control-split-h"
              onClick={actions.onSplitH}
              title="Split horizontal"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="1"
                  y="1"
                  width="12"
                  height="5"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="1"
                  y="8"
                  width="12"
                  height="5"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </BarBtn>
          )}
          {actions.onSplitV && (
            <BarBtn testId="pane-control-split-v" onClick={actions.onSplitV} title="Split vertical">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="1"
                  y="1"
                  width="5"
                  height="12"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="8"
                  y="1"
                  width="5"
                  height="12"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </BarBtn>
          )}
          {actions.onClear && (
            <BarBtn testId="pane-control-clear" onClick={actions.onClear} title="Clear view" danger>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path
                  d="M5 3l5 5-3 3-5-5z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <path d="M2 11h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path
                  d="M5 3l2.5-1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </BarBtn>
          )}
          {actions.onDelete && (
            <BarBtn
              testId="pane-control-delete"
              onClick={actions.onDelete}
              title="Delete pane"
              danger
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 3l6 6M9 3l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </BarBtn>
          )}

          <Separator />
        </>
      )}

      {showPin && (
        <BarBtn
          testId="pane-control-pin"
          onClick={() => onSetMode(mode === "pinned" ? "hover" : "pinned")}
          title={mode === "pinned" ? "Unpin" : "Pin"}
          active={mode === "pinned"}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M4.5 3L5 5.5h2L7.5 3"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
              fill={mode === "pinned" ? "currentColor" : "none"}
            />
            <path d="M6 1.5V3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M3.5 5.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M6 5.5v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </BarBtn>
      )}
      {showMinimize && (
        <BarBtn
          testId="pane-control-minimize"
          onClick={() => onSetMode("minimized")}
          title="Minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <circle cx="3" cy="6" r="1" />
            <circle cx="6" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
          </svg>
        </BarBtn>
      )}
    </div>
  );
}

/**
 * 좁은 pane(width < 360)의 컨트롤 메뉴 (issue #384).
 *
 * pane 컨테이너는 `overflow-hidden`이라 메뉴를 그 안에 렌더하면 잘려서 안 보인다.
 * 그래서 `createPortal`로 `document.body`에 띄우고 `position: fixed`로 배치해
 * pane 경계(및 어떤 stacking context)와 무관하게 항상 보이게 한다.
 *
 * 또한 이 메뉴는 PaneControlBar 루트에서 `menuOpen`만으로 렌더되므로, 사용자가
 * 떠 있는 메뉴로 커서를 옮기다 pane hover 영역을 벗어나(hovered=false) hover 바가
 * 사라져도 메뉴는 그대로 유지된다 — 예전엔 hover 바 내부에 있어 같이 사라졌다.
 */
function NarrowControlMenu({
  currentView,
  actions,
  mode,
  onSetMode,
  cwdSendOn,
  cwdReceiveOn,
  inputModeToggle,
  position,
  onRequestClose,
  triggerRef,
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  onSetMode: (m: ControlBarMode) => void;
  cwdSendOn?: boolean;
  cwdReceiveOn?: boolean;
  inputModeToggle?: PaneInputModeToggle | null;
  position: { top: number; right: number };
  onRequestClose: () => void;
  /** ⋯ 트리거 버튼. 트리거 클릭은 외부 클릭으로 보지 않는다(아래 toggle 이 닫기를 처리). */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 메뉴 밖 클릭 / Escape 로 닫기 (떠 있는 popover 표준 동작).
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // 트리거(⋯) 클릭은 무시한다 — 그쪽 onClick(toggle)이 닫기를 담당하므로
      // 여기서 닫으면 곧바로 다시 열려(close→toggle open) 버튼으로 못 닫게 된다.
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onRequestClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRequestClose();
    };
    // capture 단계로 등록해 메뉴를 연 ⋯ 버튼의 다음 클릭 등과 경합하지 않는다.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onRequestClose, triggerRef]);

  return createPortal(
    <div
      ref={menuRef}
      data-testid="pane-control-floating-menu"
      className="fixed z-50 p-1"
      style={{
        top: position.top,
        right: position.right,
        background: "var(--bar-bg-hover)",
        border: `1px solid ${sepClr}`,
        borderRadius: "var(--radius-sm)",
        boxShadow: "0 8px 18px rgba(0, 0, 0, 0.35)",
        backdropFilter: "blur(8px)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <BarContent
        currentView={currentView}
        actions={actions}
        mode={mode}
        onSetMode={onSetMode}
        cwdSendOn={cwdSendOn}
        cwdReceiveOn={cwdReceiveOn}
        inputModeToggle={inputModeToggle}
        vertical
        showMinimize={false}
      />
    </div>,
    document.body,
  );
}

/**
 * 좁은 pane 의 ⋯ 트리거 버튼. 메뉴 자체는 PaneControlBar 루트에서 portal 로 렌더한다
 * (issue #384) — 버튼만 바 안에 두어 위치 측정 기준점(buttonRef)을 제공한다.
 */
function NarrowControlAnchor({
  menuOpen,
  onToggleMenu,
  buttonRef,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
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
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="3" cy="6" r="1" />
          <circle cx="6" cy="6" r="1" />
          <circle cx="9" cy="6" r="1" />
        </svg>
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
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="3" cy="6" r="1" />
          <circle cx="6" cy="6" r="1" />
          <circle cx="9" cy="6" r="1" />
        </svg>
      </button>
    </div>
  );
}

// ─── View label map ─────────────────────────────────────
const VIEW_LABELS: Partial<Record<ViewType, string>> = {
  EmptyView: "Empty",
  MemoView: "Memo",
  IssueReporterView: "Issue Reporter",
  FileExplorerView: "File Explorer",
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
  cwdSendOn,
  cwdReceiveOn,
  paneNumber,
  workspaceId,
  workspaceName,
  dndEnabled,
  onPaneDragStart,
  onPaneDragEnd,
  children,
}: PaneControlBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
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
  const [leftBarContent, setLeftBarContentState] = useState<ReactNode>(null);
  const [inputModeToggle, setInputModeToggleState] = useState<PaneInputModeToggle | null>(null);
  const [narrowMenuOpen, setNarrowMenuOpen] = useState(false);
  const showBar = mode === "pinned" || (mode === "hover" && hovered);
  const isPinned = mode === "pinned";
  const narrowBar = paneWidth > 0 && paneWidth < 360;

  // 좁은 pane 의 떠 있는 컨트롤 메뉴(issue #384). ⋯ 버튼(NarrowControlAnchor)이
  // 어느 바에 있든 단 하나만 마운트되므로(pinned XOR hover XOR ViewHeader) 단일
  // buttonRef 로 위치 기준점을 공유한다. 메뉴 자체는 컴포넌트 루트에서 portal 로
  // 한 번만 렌더해 pane hover 생명주기와 분리한다.
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const updateMenuPosition = useCallback(() => {
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition({
      top: rect.bottom + 2,
      right: Math.max(0, window.innerWidth - rect.right),
    });
  }, []);
  const closeNarrowMenu = useCallback(() => setNarrowMenuOpen(false), []);
  const toggleNarrowMenu = useCallback(() => {
    updateMenuPosition();
    setNarrowMenuOpen((open) => !open);
  }, [updateMenuPosition]);
  // 메뉴가 열려 있는 동안 버튼 위치가 바뀔 수 있으므로(레이아웃 변화) 한 프레임 뒤 재측정.
  useEffect(() => {
    if (!narrowMenuOpen) return;
    const frame = requestAnimationFrame(updateMenuPosition);
    return () => cancelAnimationFrame(frame);
  }, [narrowMenuOpen, updateMenuPosition]);
  // pane 이 리사이즈로 넓어지면(narrowBar=false) ⋯ 트리거가 사라지므로 narrowMenuOpen 도
  // 닫는다. 그러지 않으면 다시 좁아질 때(narrowBar=true) 사용자 동작 없이 메뉴가 stale-open
  // 으로 재출현한다. effect 대신 렌더 중 state 조정(React 권장 패턴)으로 처리한다.
  if (!narrowBar && narrowMenuOpen) setNarrowMenuOpen(false);
  // 떠 있는 메뉴의 실제 가시성은 narrow 여부에서 파생한다(상태로 저장하지 않음).
  const narrowMenuVisible = narrowBar && narrowMenuOpen;

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
  const showPropagateCwd =
    (currentView.type === "TerminalView" || currentView.type === "FileExplorerView") &&
    actions.onPropagateCwdOnce != null;
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
      narrowBar ? (
        <NarrowControlAnchor
          menuOpen={narrowMenuOpen}
          onToggleMenu={toggleNarrowMenu}
          buttonRef={menuBtnRef}
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
        />
      ),
    [
      currentView,
      actions,
      mode,
      setMode,
      narrowBar,
      narrowMenuOpen,
      toggleNarrowMenu,
      cwdSendOn,
      cwdReceiveOn,
      inputModeToggle,
    ],
  );

  const registerHeader = useCallback(() => setHasViewHeader(true), []);
  const unregisterHeader = useCallback(() => setHasViewHeader(false), []);
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
      hovered,
      onSetMode: setMode,
      openControls: () => {
        // 다음 페인트에 ⋯ 버튼이 마운트되면 위치를 재측정한다(이 시점엔 ref 가 비어있을 수 있음).
        requestAnimationFrame(updateMenuPosition);
        setNarrowMenuOpen(true);
      },
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
      hovered,
      setMode,
      setNarrowMenuOpen,
      updateMenuPosition,
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
              <NarrowControlAnchor
                menuOpen={narrowMenuOpen}
                onToggleMenu={toggleNarrowMenu}
                buttonRef={menuBtnRef}
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
                <NarrowControlAnchor
                  menuOpen={narrowMenuOpen}
                  onToggleMenu={toggleNarrowMenu}
                  buttonRef={menuBtnRef}
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
                  // hover 바의 ⋯ 버튼이 마운트되면 위치를 잡아 떠 있는 메뉴를 연다.
                  requestAnimationFrame(updateMenuPosition);
                  setNarrowMenuOpen(true);
                }
              }}
            />
          )}
        </div>

        {/* 좁은 pane 의 떠 있는 컨트롤 메뉴(issue #384): pane 의 overflow-hidden /
            stacking context 밖(document.body)으로 portal 되어 클리핑되지 않으며,
            pane hover 가 풀려도(hovered=false → 바 언마운트) 유지된다. */}
        {narrowMenuVisible && (
          <NarrowControlMenu
            currentView={currentView}
            actions={actions}
            mode={mode}
            onSetMode={setMode}
            cwdSendOn={cwdSendOn}
            cwdReceiveOn={cwdReceiveOn}
            inputModeToggle={inputModeToggle}
            position={menuPosition}
            onRequestClose={closeNarrowMenu}
            triggerRef={menuBtnRef}
          />
        )}
      </div>
    </PaneControlContext.Provider>
  );
}
