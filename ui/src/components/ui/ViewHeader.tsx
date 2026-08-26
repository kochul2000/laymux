import { useEffect } from "react";
import { usePaneControl } from "@/components/layout/PaneControlContext";
import { PaneNumberBadge } from "@/components/ui/PaneNumberBadge";
import { EllipsisIcon } from "@/components/ui/icons";

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
 * - hover+!hovered: View 콘텐츠만 표시
 * - minimized: 툴바 높이를 점유하지 않고 hover 시 ⋯ 버튼만 표시
 *
 * Context 없이도 독립적으로 동작한다 (Dock 등).
 */
export function ViewHeader({
  title,
  children,
  className,
  borderBottom = true,
  testId,
}: ViewHeaderProps) {
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

  // Views with their own header used to keep a 28px bar even when their pane
  // was minimized. Keep the header registered (so PaneControlBar does not add
  // a second button), but remove it from layout and expose the same hover-only
  // entry point that terminal panes use.
  if (ctx?.mode === "minimized") {
    return (
      <div data-testid={testId} className="absolute right-0 top-0 z-20">
        {showMinimizedBtn && (
          <button
            data-testid="pane-control-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onSetMode("hover");
              ctx.openControls?.();
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
            <EllipsisIcon size={12} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={testId}
      className={`ui-toolbar relative shrink-0 pl-2 pr-1 ${className ?? ""}`.trim()}
      style={{
        background: "var(--bg-surface)",
        ...(borderBottom ? { borderBottom: "1px solid var(--border)" } : {}),
      }}
      {...ctx?.barDragProps}
    >
      <div className="flex min-w-0 flex-1 items-center self-stretch">
        <PaneNumberBadge
          number={ctx?.paneNumber}
          workspaceId={ctx?.workspaceId}
          workspaceName={ctx?.workspaceName}
        />
        {/* 좌측 pane 컨트롤 (issue #324): propagate CWD once 버튼 — 배지 우측, 우측
            컨트롤 묶음과 같은 가시성 조건 */}
        {showPaneControls && ctx.leftPaneControls && (
          <div onClick={(e) => e.stopPropagation()}>{ctx.leftPaneControls}</div>
        )}
        {title && (
          <span
            className="ui-toolbar-title"
            style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", fontWeight: 600 }}
          >
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
    </div>
  );
}
