import { useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import type { ViewInstanceConfig, ViewType } from "@/stores/types";

/**
 * 컨트롤 바 표시 모드. 각 모드는 독립적이며 서브 상태를 갖지 않는다.
 * - hover: 마우스 hover 시 표시, idle/타이핑/패인이탈 시 숨김 (기본값)
 * - pinned: 항상 표시 (콘텐츠 위에 고정)
 * - minimized: 3-dot 버튼만 표시, 클릭 시 hover로 복귀
 *
 * ⚠️ 모드 내부에 "열림/닫힘" 같은 서브 상태를 절대 추가하지 말 것.
 *    모드 전환은 항상 setMode() 한번으로 완결되어야 한다.
 */
export type ControlBarMode = "hover" | "pinned" | "minimized";

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
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  hovered: boolean;
  children: React.ReactNode;
}

// ─── Design tokens ───────────────────────────────────────
const BAR_H = 28;                     // bar height in px
const BTN_H = 22;                     // button height
const BTN_MIN_W = 22;                 // icon-only button width
const RADIUS = 2;                     // border radius

const barBg = "var(--bg-surface)";
const barBgHover = "rgba(24,24,37,0.96)";
const borderClr = "var(--border)";
const sepClr = "rgba(255,255,255,0.08)";

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
      className="flex shrink-0 cursor-pointer items-center justify-center rounded px-1.5 text-[11px]"
      style={{
        height: BTN_H,
        minWidth: BTN_MIN_W,
        background: "transparent",
        color: danger ? "var(--red)" : active ? "var(--accent)" : "var(--text-secondary)",
        border: "none",
        borderRadius: RADIUS,
        transition: "background 0.1s",
        ...style,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="mx-1" style={{ width: 1, height: 14, background: sepClr }} />;
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
  const effectiveProfile = currentView.type === "TerminalView"
    ? ((currentView.profile as string) || defaultProfile || visibleProfiles[0]?.name || "")
    : "";
  const value = currentView.type === "TerminalView"
    ? `TerminalView:${effectiveProfile}`
    : currentView.type;

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
        padding: "0 6px",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
        border: `1px solid ${sepClr}`,
        borderRadius: RADIUS,
        outline: "none",
        maxWidth: 110,
        colorScheme: "dark",
      }}
    >
      <option value="EmptyView">Empty</option>
      {visibleProfiles.map((p) => (
        <option key={p.name} value={`TerminalView:${p.name}`}>{p.name}</option>
      ))}
      <option value="BrowserPreviewView">Browser</option>
      <option value="NotepadView">Notepad</option>
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
}: {
  currentView: ViewInstanceConfig;
  actions: PaneControlBarActions;
  mode: ControlBarMode;
  onSetMode: (m: ControlBarMode) => void;
}) {
  return (
    <div
      className="flex w-full items-center justify-end gap-0.5 px-1"
      onClick={(e) => e.stopPropagation()}
    >
      {actions.onChangeView && (
        <ViewSelect currentView={currentView} onChange={actions.onChangeView} />
      )}

      {currentView.type === "TerminalView" && actions.onToggleCwdSend && (() => {
        const isOn = (currentView.cwdSend ?? true) as boolean;
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M4 5l3-3 3 3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
                  fill={isOn ? "currentColor" : "none"} />
                <path d="M7 5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M3 12h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </BarBtn>
          </>
        );
      })()}
      {currentView.type === "TerminalView" && actions.onToggleCwdReceive && (() => {
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
              <path d="M4 7l3 3 3-3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
                fill={isOn ? "currentColor" : "none"} />
              <path d="M7 2v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M3 12h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </BarBtn>
        );
      })()}

      <Sep />

      {actions.onSplitH && (
        <BarBtn testId="pane-control-split-h" onClick={actions.onSplitH} title="Split horizontal">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="12" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="8" width="12" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </BarBtn>
      )}
      {actions.onSplitV && (
        <BarBtn testId="pane-control-split-v" onClick={actions.onSplitV} title="Split vertical">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </BarBtn>
      )}
      {actions.onClear && (
        <BarBtn testId="pane-control-clear" onClick={actions.onClear} title="Clear view">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M5 3l5 5-3 3-5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M2 11h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M5 3l2.5-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </BarBtn>
      )}
      {actions.onDelete && (
        <BarBtn testId="pane-control-delete" onClick={actions.onDelete} title="Delete pane" danger>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </BarBtn>
      )}

      <Sep />

      <BarBtn
        testId="pane-control-pin"
        onClick={() => onSetMode(mode === "pinned" ? "hover" : "pinned")}
        title={mode === "pinned" ? "Unpin" : "Pin"}
        active={mode === "pinned"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M4.5 3L5 5.5h2L7.5 3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"
            fill={mode === "pinned" ? "currentColor" : "none"} />
          <path d="M6 1.5V3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M3.5 5.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M6 5.5v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </BarBtn>
      <BarBtn
        testId="pane-control-minimize"
        onClick={() => onSetMode("minimized")}
        title="Minimize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="3" cy="6" r="1" /><circle cx="6" cy="6" r="1" /><circle cx="9" cy="6" r="1" />
        </svg>
      </BarBtn>
    </div>
  );
}

/** Minimized: just a small button that expands the full bar on click. */
function MinimizedButton({
  onExpand,
}: {
  onExpand: () => void;
}) {
  return (
    <div className="absolute right-1 top-1 z-30 flex items-center" style={{ height: BAR_H }} onClick={(e) => e.stopPropagation()}>
      <button
        data-testid="pane-control-menu-btn"
        onClick={onExpand}
        className="flex cursor-pointer items-center justify-center rounded"
        style={{
          width: BTN_MIN_W,
          height: BTN_MIN_W,
          background: "rgba(0,0,0,0.4)",
          color: "var(--text-secondary)",
          border: `1px solid ${borderClr}`,
          borderRadius: RADIUS,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.4)"; }}
        title="Expand control bar"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="3" cy="6" r="1" /><circle cx="6" cy="6" r="1" /><circle cx="9" cy="6" r="1" />
        </svg>
      </button>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────
export function PaneControlBar({
  currentView,
  actions,
  hovered,
  children,
}: PaneControlBarProps) {
  const [mode, setMode] = useState<ControlBarMode>("hover");
  const showBar = mode === "pinned" || (mode === "hover" && hovered);
  const isPinned = mode === "pinned";

  if (mode === "minimized") {
    // Minimized: 3-dot 버튼만 표시. 클릭하면 hover 모드로 복귀.
    // ⚠️ 절대 "minimizedOpen" 같은 중간 상태를 추가하지 말 것.
    //    minimized 안에서 바를 임시 확장하는 서브 모드는 포커스/숨김 동작을
    //    완전히 망가뜨린다. minimize → hover 단방향 전환만 허용.
    return (
      <div className="relative h-full w-full" data-testid="pane-control-minimized">
        {children}
        {hovered && <MinimizedButton onExpand={() => setMode("hover")} />}
      </div>
    );
  }

  if (isPinned) {
    return (
      <div className="flex h-full w-full flex-col" data-testid="pane-control-pinned">
        <div
          data-testid="pane-control-bar"
          className="flex shrink-0 items-center"
          style={{
            height: BAR_H,
            background: barBg,
            borderBottom: `1px solid ${borderClr}`,
          }}
        >
          <BarContent currentView={currentView} actions={actions} mode={mode} onSetMode={setMode} />
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" data-testid="pane-control-hover">
      {children}
      {showBar && (
        <div
          data-testid="pane-control-bar"
          className="absolute right-1 top-1 z-20 flex items-center"
          style={{
            height: BAR_H,
            background: barBgHover,
            backdropFilter: "blur(8px)",
            borderBottom: `1px solid ${sepClr}`,
            borderLeft: `1px solid ${sepClr}`,
            borderRadius: `0 0 0 ${RADIUS + 2}px`,
          }}
        >
          <BarContent currentView={currentView} actions={actions} mode={mode} onSetMode={setMode} />
        </div>
      )}
    </div>
  );
}
