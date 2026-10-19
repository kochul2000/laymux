import type { TerminalActivityInfo } from "@/stores/terminal-store";
import { formatActivity } from "@/lib/workspace-summary";

/** The workspace selector's activity chip, shared by terminal navigation surfaces. */
export function TerminalActivityChip({
  activity,
  count,
  dimmed = false,
  className = "",
  testId,
}: {
  activity?: TerminalActivityInfo;
  count?: number;
  dimmed?: boolean;
  className?: string;
  testId?: string;
}) {
  const info = formatActivity(activity);
  return (
    <span
      data-testid={testId}
      className={`terminal-activity-chip shrink-0 rounded px-1 text-[9px] ${className}`.trim()}
      style={{
        color: info.color,
        background:
          activity?.type === "interactiveApp"
            ? activity.name === "Claude"
              ? "var(--orange-15)"
              : "var(--accent-12)"
            : "var(--active-bg)",
        minWidth: 40,
        textAlign: "center",
        display: "inline-block",
        lineHeight: 1.5,
        opacity: dimmed ? 0.7 : 1,
      }}
    >
      {info.label}
      {count !== undefined && ` ${count}`}
    </span>
  );
}
