import { useEffect } from "react";
import { usePaneControl } from "@/components/layout/PaneControlContext";

interface ViewHeaderProps {
  /** 헤더 제목. 지정하면 통일된 스타일(--text-secondary, --fs-sm, 600)로 렌더링. */
  title?: string;
  children?: React.ReactNode;
  className?: string;
  borderBottom?: boolean;
  testId?: string;
}

/**
 * View 통합 헤더.
 *
 * PaneControlContext가 있으면:
 * - pinned / hover+hovered: View 콘텐츠 + pane 제어를 한 줄에 표시
 * - hover+!hovered / minimized+!hovered: View 콘텐츠만 표시
 * - minimized+hovered: View 콘텐츠 + ⋯ 버튼
 *
 * Context 없이도 독립적으로 동작한다 (Dock 등).
 */
export function ViewHeader({ title, children, className, borderBottom = true, testId }: ViewHeaderProps) {
  const ctx = usePaneControl();
  const registerHeader = ctx?.registerHeader;
  const unregisterHeader = ctx?.unregisterHeader;

  // PaneControlBar에 "ViewHeader가 존재함"을 알린다.
  useEffect(() => {
    registerHeader?.();
    return () => unregisterHeader?.();
  }, [registerHeader, unregisterHeader]);

  const showPaneControls = ctx && (ctx.mode === "pinned" || (ctx.mode === "hover" && ctx.hovered));
  const showMinimizedBtn = ctx && ctx.mode === "minimized" && ctx.hovered;

  return (
    <div
      data-testid={testId}
      className={`ui-toolbar shrink-0 px-2 ${className ?? ""}`.trim()}
      style={{
        background: "var(--bg-surface)",
        ...(borderBottom ? { borderBottom: "1px solid var(--border)" } : {}),
      }}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {title && (
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", fontWeight: 600 }}>
            {title}
          </span>
        )}
        {children}
      </div>
      {showPaneControls && (
        <div data-testid="pane-control-bar-content" onClick={(e) => e.stopPropagation()}>
          {ctx.paneControls}
        </div>
      )}
      {showMinimizedBtn && (
        <button
          data-testid="pane-control-menu-btn"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onSetMode("hover");
          }}
          className="hover-bg-strong flex shrink-0 cursor-pointer items-center justify-center rounded"
          style={{
            width: "var(--btn-min-w)",
            height: "var(--btn-min-w)",
            color: "var(--text-secondary)",
            border: "none",
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
      )}
    </div>
  );
}
