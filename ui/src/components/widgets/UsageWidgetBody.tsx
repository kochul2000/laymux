/**
 * The one-line rendering shared by both usage widgets.
 *
 * The rows come from the global `usage.*.visibleRows`; the widget only owns
 * `display`. When the probe has nothing usable the numbers are replaced rather
 * than kept — a stale percentage shown as current is the failure mode ADR-0102
 * exists to prevent.
 */

import { useSettingsStore } from "@/stores/settings-store";
import type { UsageDisplayRow } from "@/lib/usage-rows";
import { USAGE_UNAVAILABLE_TEXT } from "@/lib/usage-status";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { UsageWidgetDisplay } from "./widget-options";

function Bar({ percent, testId }: { percent: number | null; testId: string }) {
  const colors = useSettingsStore((s) => s.usage.colors);
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <span
      data-testid={testId}
      className="inline-block overflow-hidden align-middle"
      style={{ width: 26, height: 4, background: colors.track, borderRadius: 2 }}
    >
      <span
        className="block"
        style={{ width: `${width}%`, height: "100%", background: colors.used }}
      />
    </span>
  );
}

export function UsageWidgetBody({
  testId,
  label,
  rows,
  display,
  message,
  capturedAtMs,
  configDir,
}: {
  testId: string;
  /** Short provider name, e.g. `Claude`. */
  label: string;
  rows: UsageDisplayRow[];
  display: UsageWidgetDisplay;
  /** Non-null whenever the numbers are not usable. */
  message: string | null;
  capturedAtMs: number | null;
  configDir?: string;
}) {
  const usable = message === null;
  const capturedLabel =
    capturedAtMs == null
      ? "never"
      : new Date(capturedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const title = [
    configDir ? `${label} (${configDir})` : label,
    message ?? rows.map((row) => `${row.label}: ${percentText(row.percent)}`).join("\n"),
    ...rows.filter((row) => row.reset).map((row) => `${row.label} resets ${row.reset}`),
    `Updated ${capturedLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <WidgetChrome testId={testId} title={title}>
      <WidgetLabel>{label}</WidgetLabel>
      {!usable && (
        // The reason lives in the tooltip; the line itself only has room to say
        // "these numbers are not current".
        <span data-testid={`${testId}-unavailable`} style={{ color: "var(--text-muted)" }}>
          {USAGE_UNAVAILABLE_TEXT}
        </span>
      )}
      {usable &&
        rows.map((row) => (
          <span key={row.key} className="flex items-center gap-1">
            {display !== "number" && (
              <Bar percent={row.percent} testId={`${testId}-bar-${row.key}`} />
            )}
            {display !== "bar" && (
              <span data-testid={`${testId}-number-${row.key}`}>{percentText(row.percent)}</span>
            )}
          </span>
        ))}
      {usable && rows.length === 0 && (
        <span style={{ color: "var(--text-muted)" }}>{USAGE_UNAVAILABLE_TEXT}</span>
      )}
    </WidgetChrome>
  );
}

function percentText(percent: number | null): string {
  return percent == null ? USAGE_UNAVAILABLE_TEXT : `${percent}%`;
}
