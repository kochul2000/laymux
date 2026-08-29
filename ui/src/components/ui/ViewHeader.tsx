import { useEffect, useLayoutEffect, useRef } from "react";
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
 * - pinned / hover+hovered: 여유가 있으면 View 콘텐츠 + pane 제어를 한 줄에 표시
 * - 실제 콘텐츠가 넘치면 ⋯ anchor + 작업영역을 바꾸지 않는 floating toolbar 표시
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
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const inlineRequiredWidthRef = useRef(0);
  const registerHeader = ctx?.registerHeader;
  const unregisterHeader = ctx?.unregisterHeader;
  const reportHeaderControlsOverflow = ctx?.reportHeaderControlsOverflow;

  // PaneControlBar에 "ViewHeader가 존재함"을 알린다.
  useEffect(() => {
    registerHeader?.();
    return () => {
      reportHeaderControlsOverflow?.(false);
      unregisterHeader?.();
    };
  }, [registerHeader, reportHeaderControlsOverflow, unregisterHeader]);

  const showPaneControls = ctx && (ctx.mode === "pinned" || (ctx.mode === "hover" && ctx.hovered));
  const showMinimizedBtn = ctx && ctx.mode === "minimized" && ctx.hovered;
  const floatingControls = ctx?.floatingControls ?? false;
  const openControls = ctx?.openControls;

  // Full controls remain inline only while the View's actual non-shrinking
  // content fits. Cache the width that failed so replacing the full controls
  // with the small anchor cannot immediately oscillate back to inline. Run
  // after every commit as well as on ResizeObserver notifications: GitHub
  // counts and other child text can change scrollWidth without changing the
  // observed flex item's border box.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content || !reportHeaderControlsOverflow) return;

    const measure = () => {
      const rootWidth = root.clientWidth || root.getBoundingClientRect().width;
      if (rootWidth <= 0) return;

      if (!floatingControls && showPaneControls && controlsRef.current) {
        const overflow = Math.max(
          0,
          content.scrollWidth - content.clientWidth,
          root.scrollWidth - root.clientWidth,
        );
        if (overflow > 1) {
          inlineRequiredWidthRef.current = Math.ceil(rootWidth + overflow + 4);
          reportHeaderControlsOverflow(true);
        } else {
          inlineRequiredWidthRef.current = 0;
          reportHeaderControlsOverflow(false);
        }
        return;
      }

      const requiredWidth = inlineRequiredWidthRef.current;
      if (floatingControls && requiredWidth > 0 && rootWidth >= requiredWidth) {
        inlineRequiredWidthRef.current = 0;
        reportHeaderControlsOverflow(false);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(content);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => observer.disconnect();
  });

  // Hover mode previously exposed the full controls as soon as the pane was
  // hovered. Preserve that discovery behavior when they move to a portal.
  // Pinned mode keeps the compact anchor and opens explicitly, avoiding a
  // permanent overlay over the View body.
  useLayoutEffect(() => {
    if (floatingControls && ctx?.mode === "hover" && ctx.hovered) {
      openControls?.("hover");
    }
  }, [ctx?.hovered, ctx?.mode, floatingControls, openControls]);

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
      ref={rootRef}
      data-testid={testId}
      className={`ui-toolbar relative shrink-0 pl-2 pr-1 ${className ?? ""}`.trim()}
      style={{
        background: "var(--bg-surface)",
        ...(borderBottom ? { borderBottom: "1px solid var(--border)" } : {}),
      }}
      {...ctx?.barDragProps}
    >
      <div
        ref={contentRef}
        data-testid="view-header-content"
        className="flex min-w-0 flex-1 items-center self-stretch"
      >
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
            className="ui-toolbar-title shrink-0"
            style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", fontWeight: 600 }}
          >
            {title}
          </span>
        )}
        {children}
      </div>
      {showPaneControls && (
        <div
          ref={controlsRef}
          data-testid="pane-control-bar-content"
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.paneControls}
        </div>
      )}
    </div>
  );
}
