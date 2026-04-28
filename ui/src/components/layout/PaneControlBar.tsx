import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useSettingsStore, type ControlBarMode } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import type { ViewInstanceConfig, ViewType } from "@/stores/types";
import { PaneControlContext } from "./PaneControlContext";
import { useContainerSize } from "@/hooks/useContainerSize";

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
}

interface PaneControlBarProps {
  /** Stable pane ID for persisting control bar mode across restarts. */
  paneId?: string;
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  hovered: boolean;
  children: React.ReactNode;
}

// ─── Design tokens ───────────────────────────────────────
const BAR_H = "var(--bar-h)";
const BTN_H = "var(--btn-h)";
const BTN_MIN_W = "var(--btn-min-w)";
const barBg = "var(--bg-surface)";
const barBgHover = "var(--bar-bg-hover)";
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
              const isOn = (currentView.cwdSend ?? true) as boolean;
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
              const isOn = (currentView.cwdReceive ?? true) as boolean;
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

function NarrowControlMenu({
  currentView,
  actions,
  mode,
  onSetMode,
  position,
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  onSetMode: (m: ControlBarMode) => void;
  position: { top: number; right: number };
}) {
  return (
    <div
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
        vertical
        showPin={false}
        showMinimize={false}
      />
    </div>
  );
}

function NarrowControlAnchor({
  currentView,
  actions,
  mode,
  menuOpen,
  onToggleMenu,
  onSetMode,
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onSetMode: (m: ControlBarMode) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const updateMenuPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition({
      top: rect.bottom + 2,
      right: Math.max(0, window.innerWidth - rect.right),
    });
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(updateMenuPosition);
    return () => cancelAnimationFrame(frame);
  }, [menuOpen, updateMenuPosition]);

  return (
    <div className="flex shrink-0 justify-end" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        data-testid="pane-control-menu-btn"
        onClick={() => {
          updateMenuPosition();
          onToggleMenu();
        }}
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
      {menuOpen && (
        <NarrowControlMenu
          currentView={currentView}
          actions={actions}
          mode={mode}
          onSetMode={onSetMode}
          position={menuPosition}
        />
      )}
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
    <div className="flex min-w-0 flex-1 items-center text-[11px]">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────
export function PaneControlBar({
  paneId,
  currentView,
  actions,
  hovered,
  children,
}: PaneControlBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { w: paneWidth } = useContainerSize(rootRef);
  const persistedMode = useOverridesStore((s) =>
    paneId ? s.paneOverrides[paneId]?.controlBarMode : undefined,
  );
  const defaultMode = useSettingsStore((s) => s.convenience.defaultControlBarMode);
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
  const [narrowMenuOpen, setNarrowMenuOpen] = useState(false);
  const showBar = mode === "pinned" || (mode === "hover" && hovered);
  const isPinned = mode === "pinned";
  const narrowBar = paneWidth > 0 && paneWidth < 360;

  // 모든 모드에서 children을 동일한 DOM 위치에 유지하여
  // pin/unpin 전환 시 React가 children을 리마운트하지 않도록 한다.
  const modeTestId =
    mode === "minimized"
      ? "pane-control-minimized"
      : isPinned
        ? "pane-control-pinned"
        : "pane-control-hover";

  const hasBarLabel = currentView.type !== "TerminalView" && currentView.type !== "EmptyView";
  // 자식(TerminalView 등)이 주입한 좌측 콘텐츠가 있으면 기본 BarLabel 대신 사용.
  // 둘 다 없으면 flex-1 스페이서만 렌더하여 pane 컨트롤이 오른쪽 끝에 정렬되도록 한다.
  const hasLeftContent = hasBarLabel || leftBarContent != null;

  const paneControls = useMemo(
    () =>
      narrowBar ? (
        <NarrowControlAnchor
          currentView={currentView}
          actions={actions}
          mode={mode}
          menuOpen={narrowMenuOpen}
          onToggleMenu={() => setNarrowMenuOpen((open) => !open)}
          onSetMode={setMode}
        />
      ) : (
        <BarContent currentView={currentView} actions={actions} mode={mode} onSetMode={setMode} />
      ),
    [currentView, actions, mode, setMode, narrowBar, narrowMenuOpen],
  );

  const registerHeader = useCallback(() => setHasViewHeader(true), []);
  const unregisterHeader = useCallback(() => setHasViewHeader(false), []);
  const setLeftBarContent = useCallback((node: ReactNode) => {
    setLeftBarContentState(node ?? null);
  }, []);

  const ctxValue = useMemo(
    () => ({
      paneControls,
      mode,
      hovered,
      onSetMode: setMode,
      openControls: () => setNarrowMenuOpen(true),
      registerHeader,
      unregisterHeader,
      leftBarContent,
      setLeftBarContent,
    }),
    [
      paneControls,
      mode,
      hovered,
      setMode,
      setNarrowMenuOpen,
      registerHeader,
      unregisterHeader,
      leftBarContent,
      setLeftBarContent,
    ],
  );

  return (
    <PaneControlContext.Provider value={ctxValue}>
      <div ref={rootRef} className="flex h-full w-full flex-col" data-testid={modeTestId}>
        {/* Pinned bar: ViewHeader가 없는 View만 자체 바 렌더 */}
        {isPinned && !hasViewHeader && (
          <div
            data-testid="pane-control-bar"
            className="ui-toolbar relative shrink-0 pl-2 pr-1"
            style={{
              background: barBg,
              borderBottom: `1px solid ${borderClr}`,
            }}
          >
            {hasBarLabel ? (
              <BarLabel viewType={currentView.type} />
            ) : leftBarContent ? (
              <div data-testid="pane-control-bar-left" className="flex min-w-0 flex-1 items-center">
                {leftBarContent}
              </div>
            ) : (
              <div className="flex-1" />
            )}
            {narrowBar ? (
              <NarrowControlAnchor
                currentView={currentView}
                actions={actions}
                mode={mode}
                menuOpen={narrowMenuOpen}
                onToggleMenu={() => setNarrowMenuOpen((open) => !open)}
                onSetMode={setMode}
              />
            ) : (
              <BarContent
                currentView={currentView}
                actions={actions}
                mode={mode}
                onSetMode={setMode}
              />
            )}
          </div>
        )}

        {/* children은 항상 이 위치에 렌더링 — 모드 전환으로 리마운트되지 않음 */}
        <div className="relative min-h-0 flex-1">
          {children}

          {/* Hover bar: ViewHeader가 없는 View만 overlay */}
          {!isPinned && !hasViewHeader && mode !== "minimized" && showBar && (
            <div
              data-testid="pane-control-bar"
              className={`absolute top-0 z-20 flex items-center pr-1 ${
                hasLeftContent || narrowBar ? "left-0 right-0 pl-2" : "right-0 pl-0.5"
              }`}
              style={{
                minHeight: BAR_H,
                background: barBgHover,
                backdropFilter: "blur(8px)",
                borderBottom: `1px solid ${sepClr}`,
                ...(!hasLeftContent && !narrowBar ? { borderLeft: `1px solid ${sepClr}` } : {}),
                borderRadius: 0,
              }}
            >
              {hasBarLabel ? (
                <BarLabel viewType={currentView.type} />
              ) : leftBarContent ? (
                <div
                  data-testid="pane-control-bar-left"
                  className="flex min-w-0 flex-1 items-center"
                >
                  {leftBarContent}
                </div>
              ) : null}
              {narrowBar ? (
                <NarrowControlAnchor
                  currentView={currentView}
                  actions={actions}
                  mode={mode}
                  menuOpen={narrowMenuOpen}
                  onToggleMenu={() => setNarrowMenuOpen((open) => !open)}
                  onSetMode={setMode}
                />
              ) : (
                <BarContent
                  currentView={currentView}
                  actions={actions}
                  mode={mode}
                  onSetMode={setMode}
                />
              )}
            </div>
          )}

          {/* Minimized: ViewHeader가 없는 View만 3-dot 버튼 */}
          {mode === "minimized" && !hasViewHeader && hovered && (
            <MinimizedButton
              onExpand={() => {
                setMode("hover");
                setNarrowMenuOpen(narrowBar);
              }}
            />
          )}
        </div>
      </div>
    </PaneControlContext.Provider>
  );
}
