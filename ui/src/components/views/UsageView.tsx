import { useMemo, useRef } from "react";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useNowTick, useUsageSnapshot } from "@/hooks/useUsageSnapshot";
import { useOverridesStore } from "@/stores/overrides-store";
import { useSettingsStore, type UsageVisibleRow } from "@/stores/settings-store";
import {
  resolveUsageLayout,
  resolveUsageDensity,
  showsDetail,
  type UsageLayout,
  type UsageLayoutPreference,
} from "@/lib/usage-layout";
import { sessionElapsedPercent, weekElapsedPercent } from "@/lib/usage-pace";
import type { UsageLimit, UsageProbeStatus, UsageSnapshot } from "@/lib/tauri-api";

/** Pace is time-derived, so re-render on a slow tick. */
const TICK_MS = 30_000;

interface UsageViewProps {
  /** `CLAUDE_CONFIG_DIR` to monitor. Empty = default config dir. */
  configDir?: string;
  /** View-instance key for the layout override (localStorage). */
  paneId?: string;
}

/** One limit row, resolved for display. */
interface Row {
  key: "session" | "week-all" | "week-model";
  visibleKey: UsageVisibleRow;
  label: string;
  limit: UsageLimit;
  /** Elapsed percentage of this row's billing window, when derivable. */
  elapsed: number | null;
}

function statusMessage(status: UsageProbeStatus): string | null {
  switch (status.type) {
    case "ready":
      return null;
    case "idle":
      return "Probe stopped";
    case "starting":
      return "Starting Claude Code…";
    case "claudeMissing":
      return "`claude` not found in this profile's shell";
    case "startupTimeout":
      return "Claude Code did not become ready";
    case "parseFailed":
      return "Could not read the /usage panel";
    case "upstreamError":
      return status.message;
    case "failed":
      return status.message;
  }
}

function buildRows(snapshot: UsageSnapshot, now: Date): Row[] {
  return [
    {
      key: "session",
      visibleKey: "session",
      label: "Current session",
      limit: snapshot.session,
      elapsed: sessionElapsedPercent(snapshot.session.reset, now),
    },
    {
      key: "week-all",
      visibleKey: "weekAll",
      label: "Current week (all models)",
      limit: snapshot.weekAll,
      elapsed: weekElapsedPercent(snapshot.weekAll.reset, now),
    },
    {
      key: "week-model",
      visibleKey: "weekModel",
      // The label comes from the panel, which names this row after the account's
      // model. Falling back to a generic title is better than naming a model the
      // account may not be on.
      label: snapshot.weekModelLabel
        ? `Current week (${snapshot.weekModelLabel})`
        : "Current week (per model)",
      limit: snapshot.weekModel,
      elapsed: weekElapsedPercent(snapshot.weekModel.reset, now),
    },
  ];
}

const PACE_METER_HEIGHT = "3px";
/** Below this width a limit row cannot carry its full labels comfortably. */
const ABBREVIATED_ROW_MAX_WIDTH = 240;

function displayRowLabel(row: Row, abbreviated: boolean): string {
  if (!abbreviated) return row.label;
  if (row.key === "session") return "session";
  if (row.key === "week-all") return "week (all)";
  return row.label.replace(/^Current /, "");
}

/** Fixed-height meter. Renders an empty track when the value is unknown. */
function Meter({
  percent,
  color,
  testId,
  height,
}: {
  percent: number | null;
  color: string;
  testId: string;
  height: string;
}) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div
      data-testid={testId}
      className="w-full overflow-hidden"
      style={{
        height,
        background: "var(--usage-track)",
      }}
    >
      <div style={{ width: `${width}%`, height: "100%", background: color }} />
    </div>
  );
}

function RowBlock({
  row,
  detailed,
  abbreviated,
  density,
}: {
  row: Row;
  detailed: boolean;
  abbreviated: boolean;
  density: ReturnType<typeof resolveUsageDensity>;
}) {
  const used = row.limit.percent;

  return (
    <div
      data-testid={`usage-row-${row.key}`}
      className="flex min-w-0 flex-col"
      style={{ gap: density.blockGap }}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span
          className="truncate"
          style={{
            color: "var(--text-secondary)",
            fontSize: density.labelFontSize,
            fontWeight: 400,
          }}
        >
          {displayRowLabel(row, abbreviated)}
        </span>
        <span
          data-testid={`usage-percent-${row.key}`}
          style={{
            color: "var(--text-secondary)",
            fontSize: density.labelFontSize,
            fontWeight: 600,
          }}
        >
          {used == null ? "--" : `${used}%`}
        </span>
      </div>

      <Meter
        percent={used}
        color="var(--usage-used)"
        testId={`usage-meter-used-${row.key}`}
        height={density.usedMeterHeight}
      />

      {detailed && row.elapsed != null && (
        <Meter
          percent={row.elapsed}
          color="var(--usage-pace)"
          testId={`usage-meter-pace-${row.key}`}
          height={PACE_METER_HEIGHT}
        />
      )}

      {detailed && density.showDetailText && (row.limit.reset || row.elapsed != null) && (
        <div
          data-testid={`usage-detail-${row.key}`}
          className="flex min-w-0 items-baseline justify-between gap-2"
        >
          <span
            className="truncate"
            style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}
          >
            {row.limit.reset
              ? `${abbreviated ? "" : "Resets "}${row.limit.reset}`
              : "Reset unavailable"}
          </span>
          {row.elapsed != null && (
            <span
              className="shrink-0"
              style={{ color: "var(--usage-pace)", fontSize: "var(--fs-xs)" }}
            >
              {row.elapsed}%{abbreviated ? "" : " elapsed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CompactRow({ rows }: { rows: Row[] }) {
  return (
    <div className="flex h-full min-w-0 flex-row items-center gap-1 p-2">
      {rows.map((row) => {
        const used = row.limit.percent;
        return (
          <div
            key={row.key}
            data-testid={`usage-row-${row.key}`}
            className="flex min-w-0 flex-1 flex-col gap-1"
          >
            <Meter
              percent={used}
              color="var(--usage-used)"
              testId={`usage-meter-used-${row.key}`}
              height={PACE_METER_HEIGHT}
            />
            <Meter
              percent={row.elapsed}
              color="var(--usage-pace)"
              testId={`usage-meter-pace-${row.key}`}
              height={PACE_METER_HEIGHT}
            />
          </div>
        );
      })}
    </div>
  );
}

const LAYOUT_CYCLE: UsageLayoutPreference[] = ["auto", "stacked", "columns", "compact"];

export function UsageView({ configDir = "", paneId }: UsageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(containerRef);
  const now = useNowTick(TICK_MS);

  // The subscriber id must be stable per view instance and distinct per pane, or
  // two panes would fight over one probe claim.
  const subscriberId = `usage-${paneId ?? "dock"}`;
  const { snapshot, error, refresh } = useUsageSnapshot(subscriberId, configDir);

  const preference = useOverridesStore((s) =>
    paneId ? s.viewOverrides[paneId]?.usageLayout : undefined,
  );
  const setViewOverride = useOverridesStore((s) => s.setViewOverride);
  const visibleRows = useSettingsStore((s) => s.usage.claude.visibleRows);
  const terminalFontFamily = useSettingsStore((s) => {
    const profileName = s.usage.claude.profile || s.defaultProfile;
    const font = s.resolveFont(profileName);
    return `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
  });

  const rows = useMemo(
    () => buildRows(snapshot, now).filter((row) => visibleRows.includes(row.visibleKey)),
    [snapshot, now, visibleRows],
  );
  const layout: UsageLayout = resolveUsageLayout(
    { width: size.w, height: size.h },
    preference ?? "auto",
    rows.length,
  );
  const detailed = showsDetail(layout);
  const density = resolveUsageDensity(size.h, rows.length);
  const rowWidth = layout === "columns" ? size.w / Math.max(1, rows.length) : size.w;
  const abbreviated = rowWidth < ABBREVIATED_ROW_MAX_WIDTH;
  const message = error ?? statusMessage(snapshot.status);

  const cycleLayout = () => {
    if (!paneId) return;
    const current = preference ?? "auto";
    const next = LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(current) + 1) % LAYOUT_CYCLE.length];
    setViewOverride(paneId, { usageLayout: next });
  };

  const capturedLabel =
    snapshot.capturedAtMs == null
      ? "never"
      : new Date(snapshot.capturedAtMs).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

  return (
    <ViewShell testId="usage-view" style={{ fontFamily: terminalFontFamily }}>
      <ViewHeader testId="usage-header" title="Claude Usage">
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2">
          {snapshot.plan && (
            <span
              data-testid="usage-plan"
              className="truncate"
              style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}
            >
              {snapshot.plan}
              {snapshot.model ? ` · ${snapshot.model}` : ""}
            </span>
          )}
          {configDir && (
            <span
              className="truncate"
              style={{ color: "var(--text-muted)", fontSize: "var(--fs-2xs)" }}
              title={configDir}
            >
              {configDir}
            </span>
          )}
        </div>
        <button
          data-testid="usage-layout-toggle"
          onClick={cycleLayout}
          className="hover-bg-strong shrink-0 cursor-pointer px-1.5"
          style={{
            height: "var(--btn-h)",
            border: "none",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: "var(--fs-xs)",
          }}
          title={`Layout: ${preference ?? "auto"} (click to change)`}
        >
          {preference ?? "auto"}
        </button>
        <button
          data-testid="usage-refresh"
          onClick={refresh}
          className="hover-bg-strong shrink-0 cursor-pointer px-1.5"
          style={{
            height: "var(--btn-h)",
            border: "none",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: "var(--fs-xs)",
          }}
          title="Query /usage now"
        >
          refresh
        </button>
      </ViewHeader>

      <ViewBody variant="full">
        <div
          ref={containerRef}
          data-testid="usage-body"
          data-layout={layout}
          className="flex h-full min-h-0 w-full flex-col overflow-auto"
          style={{ background: "var(--bg-base)" }}
        >
          {layout === "compact" ? (
            <CompactRow rows={rows} />
          ) : (
            // Center the group in surplus space. Its fixed 8px edge padding
            // remains intact while density contracts the internal gaps.
            <div
              className={
                layout === "columns"
                  ? "grid min-h-0 w-full flex-1 content-center p-2"
                  : "flex min-h-0 w-full flex-1 flex-col justify-center p-2"
              }
              style={{
                gap: density.rowGap,
                ...(layout === "columns"
                  ? { gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }
                  : {}),
              }}
              data-testid="usage-content"
            >
              {rows.map((row) => (
                <RowBlock
                  key={row.key}
                  row={row}
                  detailed={detailed}
                  abbreviated={abbreviated}
                  density={density}
                />
              ))}
            </div>
          )}

          {detailed && density.showFooter && (
            <div
              data-testid="usage-footer"
              className="flex shrink-0 items-center justify-between gap-2 px-2 pb-2"
              style={{ color: "var(--text-muted)", fontSize: "var(--fs-2xs)" }}
            >
              <span data-testid="usage-status" className="truncate">
                {message ?? "Ready"}
              </span>
              <span className="shrink-0">Last capture {capturedLabel}</span>
            </div>
          )}
        </div>
      </ViewBody>
    </ViewShell>
  );
}
