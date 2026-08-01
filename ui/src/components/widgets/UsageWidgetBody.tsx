/**
 * The one-line rendering shared by both usage widgets.
 *
 * The rows come from the global `usage.*.visibleRows`; the widget only owns
 * `display`. When the probe has nothing usable the numbers are replaced rather
 * than kept — a stale percentage shown as current is the failure mode ADR-0102
 * exists to prevent.
 */

import type { UsageDisplayRow } from "@/lib/usage-rows";
import type { UsageColorSettings } from "@/stores/settings-store";
import { USAGE_UNAVAILABLE_TEXT } from "@/lib/usage-status";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { UsageWidgetDisplay } from "./widget-options";

type UsageMeterColors = UsageColorSettings;

function Track({
  percent,
  color,
  track,
  height,
  width,
  testId,
}: {
  percent: number | null;
  color: string;
  track: string;
  height: number;
  width: number;
  testId: string;
}) {
  const fillWidth = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <span
      data-testid={testId}
      className="block overflow-hidden"
      style={{ width, height, background: track }}
    >
      <span
        className="block"
        style={{ width: `${fillWidth}%`, height: "100%", background: color }}
      />
    </span>
  );
}

/**
 * Consumed over elapsed, the same pairing `UsageView` draws.
 *
 * The second bar is what makes the first one readable: 40% used means one thing
 * a tenth of the way into a window and another thing nine tenths in. Showing
 * consumption without the clock invites exactly that misreading, so the two
 * stack together and the elapsed bar is omitted only when the provider gave no
 * window to derive it from.
 */
function Bar({
  percent,
  elapsed,
  usedHeight,
  elapsedHeight,
  barWidth,
  colors,
  testId,
  paceTestId,
}: {
  percent: number | null;
  elapsed: number | null;
  usedHeight: number;
  elapsedHeight: number;
  barWidth: number;
  colors: UsageMeterColors;
  testId: string;
  paceTestId: string;
}) {
  return (
    <span className="inline-flex flex-col justify-center gap-0.5 align-middle">
      <Track
        percent={percent}
        color={colors.used}
        track={colors.track}
        height={usedHeight}
        width={barWidth}
        testId={testId}
      />
      {elapsed != null && (
        <Track
          percent={elapsed}
          color={colors.pace}
          track={colors.track}
          height={elapsedHeight}
          width={barWidth}
          testId={paceTestId}
        />
      )}
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
  dragRegion,
  colors,
  usedHeight,
  elapsedHeight,
  barWidth,
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
  dragRegion?: boolean;
  /** The agent's own palette — providers are told apart by colour. */
  colors: UsageMeterColors;
  usedHeight: number;
  elapsedHeight: number;
  barWidth: number;
}) {
  const usable = message === null;
  const capturedLabel =
    capturedAtMs == null
      ? "never"
      : new Date(capturedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const title = [
    configDir ? `${label} (${configDir})` : label,
    // Both numbers, because the two stacked bars are too small to read a gap
    // between consumption and elapsed time off the pixels alone.
    message ??
      rows
        .map(
          (row) =>
            `${row.label}: ${percentText(row.percent)}` +
            (row.elapsed == null ? "" : ` · ${row.elapsed}% elapsed`),
        )
        .join("\n"),
    ...rows.filter((row) => row.reset).map((row) => `${row.label} resets ${row.reset}`),
    `Updated ${capturedLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <WidgetChrome testId={testId} title={title} dragRegion={dragRegion}>
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
              <Bar
                percent={row.percent}
                elapsed={row.elapsed}
                usedHeight={usedHeight}
                elapsedHeight={elapsedHeight}
                barWidth={barWidth}
                colors={colors}
                testId={`${testId}-bar-${row.key}`}
                paceTestId={`${testId}-pace-${row.key}`}
              />
            )}
            {display !== "bar" && (
              <span data-testid={`${testId}-number-${row.key}`}>{statuslineText(row)}</span>
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

function statuslineText(row: UsageDisplayRow): string {
  const percent = percentText(row.percent);
  return row.statuslineLabel == null ? percent : `${row.statuslineLabel} ${percent}`;
}
