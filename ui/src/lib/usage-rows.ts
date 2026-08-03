/**
 * Provider-neutral row shapes for the shared usage surface.
 *
 * Lives outside the view file so the presentation component stays the only
 * export there (react-refresh) and so row selection is unit-testable.
 */

import { sessionElapsedPercent, weekElapsedPercent } from "@/lib/usage-pace";
import { USAGE_UNAVAILABLE_TEXT } from "@/lib/usage-status";
import type { CodexUsageLimit, UsageSnapshot } from "@/lib/tauri-api";
import type { CodexUsageVisibleRow, UsageVisibleRow } from "@/stores/settings-store";

/** One limit row, already resolved for display. */
export interface UsageDisplayRow {
  key: string;
  label: string;
  /** Short label used by one-line statusline rows. */
  statuslineLabel?: string;
  abbreviatedLabel?: string;
  percent: number | null;
  reset: string | null;
  elapsed: number | null;
}

/**
 * One row plus the settings key that decides whether it is shown. Keeping the
 * key on the row means `visibleRows` filtering never depends on row order.
 */
export interface KeyedUsageRow<VisibleKey extends string> {
  visibleKey: VisibleKey;
  row: UsageDisplayRow;
}

/** Filter provider rows by the user's visible-row selection, order-independently. */
export function selectVisibleRows<VisibleKey extends string>(
  rows: KeyedUsageRow<VisibleKey>[],
  visibleRows: readonly VisibleKey[],
): UsageDisplayRow[] {
  return rows.filter((entry) => visibleRows.includes(entry.visibleKey)).map((entry) => entry.row);
}

/**
 * Claude's three limit rows.
 *
 * Lives here rather than in the view so a UsageView and a status widget showing
 * the same account cannot disagree about what a row means (ADR-0105).
 */
export function buildClaudeUsageRows(
  snapshot: UsageSnapshot,
  now: Date,
): KeyedUsageRow<UsageVisibleRow>[] {
  return [
    {
      visibleKey: "session",
      row: {
        key: "session",
        label: "Current session",
        statuslineLabel: "Session",
        abbreviatedLabel: "session",
        percent: snapshot.session.percent,
        reset: snapshot.session.reset,
        elapsed: sessionElapsedPercent(snapshot.session.reset, now),
      },
    },
    {
      visibleKey: "weekAll",
      row: {
        key: "week-all",
        label: "Current week (all models)",
        statuslineLabel: "Week",
        abbreviatedLabel: "week (all)",
        percent: snapshot.weekAll.percent,
        reset: snapshot.weekAll.reset,
        elapsed: weekElapsedPercent(snapshot.weekAll.reset, now),
      },
    },
    {
      visibleKey: "weekModel",
      row: {
        key: "week-model",
        label: snapshot.weekModelLabel
          ? `Current week (${snapshot.weekModelLabel})`
          : "Current week (per model)",
        statuslineLabel: snapshot.weekModelLabel ?? "Model",
        abbreviatedLabel: snapshot.weekModelLabel ? `week (${snapshot.weekModelLabel})` : "week",
        percent: snapshot.weekModel.percent,
        reset: snapshot.weekModel.reset,
        elapsed: weekElapsedPercent(snapshot.weekModel.reset, now),
      },
    },
  ];
}

function isSparkLimit(key: string, label: string): boolean {
  return /spark/i.test(`${key} ${label}`);
}

function resetText(resetsAtSecs: number): string {
  return new Date(resetsAtSecs * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Codex's limit rows.
 *
 * Only primary windows become rows: the secondary window is a nested horizon of
 * the same quota, not the separate Spark limit users select.
 */
export function buildCodexUsageRows(
  limits: readonly CodexUsageLimit[],
  now: Date,
): KeyedUsageRow<CodexUsageVisibleRow>[] {
  return limits
    .filter((limit) => limit.kind === "primary")
    .map((limit) => {
      const spark = isSparkLimit(limit.key, limit.label);
      const totalMs = limit.windowDurationMins * 60_000;
      const startMs = limit.resetsAtSecs * 1000 - totalMs;
      const elapsed =
        totalMs > 0
          ? Math.max(0, Math.min(100, Math.round(((now.getTime() - startMs) / totalMs) * 100)))
          : null;
      return {
        visibleKey: spark ? ("sparkWeekly" as const) : ("weekly" as const),
        row: {
          key: limit.key,
          label: spark ? "Spark Weekly limit" : "Weekly limit",
          statuslineLabel: spark ? "Spark" : "Week",
          abbreviatedLabel: spark ? "Spark" : "Weekly",
          percent: limit.usedPercent,
          reset: resetText(limit.resetsAtSecs),
          elapsed,
        },
      };
    });
}

/**
 * The text a one-line surface prints for a row.
 *
 * Lives beside the row builders, not in the React body, because the remote
 * client draws the same rows from a payload rather than from these objects
 * (ADR-0124). Two implementations of "what this row says" would let the same
 * limit read differently on the desktop and in a browser.
 */
export function usageRowPercentText(percent: number | null): string {
  return percent == null ? USAGE_UNAVAILABLE_TEXT : `${percent}%`;
}

export function usageRowStatuslineText(row: UsageDisplayRow): string {
  const percent = usageRowPercentText(row.percent);
  return row.statuslineLabel == null ? percent : `${row.statuslineLabel} ${percent}`;
}

/**
 * The hover text a one-line usage surface carries.
 *
 * Both numbers per row, because two stacked bars are too small to read a gap
 * between consumption and elapsed time off the pixels alone, and the capture
 * time, because a one-line surface has no room to say how old it is.
 */
export function usageWidgetTooltip({
  label,
  configDir,
  message,
  rows,
  capturedAtMs,
}: {
  label: string;
  configDir?: string;
  /** Non-null whenever the numbers are not usable. */
  message: string | null;
  rows: readonly UsageDisplayRow[];
  capturedAtMs: number | null;
}): string {
  const capturedLabel =
    capturedAtMs == null
      ? "never"
      : new Date(capturedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return [
    configDir ? `${label} (${configDir})` : label,
    message ??
      rows
        .map(
          (row) =>
            `${row.label}: ${usageRowPercentText(row.percent)}` +
            (row.elapsed == null ? "" : ` · ${row.elapsed}% elapsed`),
        )
        .join("\n"),
    ...rows.filter((row) => row.reset).map((row) => `${row.label} resets ${row.reset}`),
    `Updated ${capturedLabel}`,
  ]
    .filter(Boolean)
    .join("\n");
}
