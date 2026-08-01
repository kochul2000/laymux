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
  children,
}: {
  testId: string;
  title: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const style = {
    color: "var(--text-secondary)",
    fontSize: "var(--fs-2xs)",
    background: "transparent",
    border: "none",
    borderRadius: "var(--radius-sm)",
  } as const;

  if (!onClick) {
    return (
      <div data-testid={testId} className={CHROME_CLASS} style={style} title={title}>
        {children}
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
