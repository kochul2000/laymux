/**
 * Shared shell for every widget: one line, one tooltip, one optional click.
 *
 * Keeping the chrome here is what lets a widget file be about its data only,
 * and it is the single place that knows a widget must never grow a second line.
 */

import type { ReactNode } from "react";

const CHROME_CLASS = "flex h-full min-w-0 shrink-0 items-center gap-1 whitespace-nowrap px-1.5";

export function WidgetChrome({
  testId,
  title,
  onClick,
  dragRegion,
  children,
}: {
  testId: string;
  title: string;
  onClick?: () => void;
  /**
   * Let the window be dragged by this widget.
   *
   * Tauri tests the exact event target, not its ancestors, so the attribute has
   * to sit on the element the pointer lands on — hence here rather than on a
   * wrapper. The content is made pointer-transparent for the same reason; the
   * tooltip still works because `title` stays on this element.
   */
  dragRegion?: boolean;
  children: ReactNode;
}) {
  const style = {
    color: "var(--text-secondary)",
    fontSize: "inherit",
    lineHeight: 1,
    background: "transparent",
    border: "none",
  } as const;

  if (!onClick) {
    return (
      <div
        data-testid={testId}
        className={CHROME_CLASS}
        style={style}
        title={title}
        {...(dragRegion ? { "data-tauri-drag-region": "true" } : {})}
      >
        {dragRegion ? (
          // `display: contents` keeps the layout identical; `pointer-events`
          // inherits down so no descendant can become the drag target.
          <span style={{ display: "contents", pointerEvents: "none" }}>{children}</span>
        ) : (
          children
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      className={`${CHROME_CLASS} hover-bg cursor-pointer`}
      style={style}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Dim leading text that names what the numbers belong to. */
export function WidgetLabel({ children }: { children: ReactNode }) {
  return <span style={{ color: "var(--text-muted)" }}>{children}</span>;
}
