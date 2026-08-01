import { useMemo, useRef } from "react";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useNowTick, useUsageSnapshot } from "@/hooks/useUsageSnapshot";
import { useOverridesStore } from "@/stores/overrides-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  resolveUsageDensity,
  resolveUsageLayout,
  showsDetail,
  type UsageLayoutPreference,
} from "@/lib/usage-layout";
import { buildClaudeUsageRows, selectVisibleRows, type UsageDisplayRow } from "@/lib/usage-rows";
import { claudeUsageStatusMessage } from "@/lib/usage-status";

const TICK_MS = 30_000;
const PACE_METER_HEIGHT = "3px";
const ABBREVIATED_ROW_MAX_WIDTH = 240;
const LAYOUT_CYCLE: UsageLayoutPreference[] = ["auto", "stacked", "columns", "compact"];

interface UsageViewProps {
  configDir?: string;
  paneId?: string;
}

function Meter({
  percent,
  color,
  track,
  testId,
  height,
}: {
  percent: number | null;
  color: string;
  track: string;
  testId: string;
  height: string;
}) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div
      data-testid={testId}
      className="w-full overflow-hidden"
      style={{ height, background: track }}
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
  colors,
}: {
  row: UsageDisplayRow;
  detailed: boolean;
  abbreviated: boolean;
  density: ReturnType<typeof resolveUsageDensity>;
  colors: { used: string; pace: string; track: string };
}) {
  const label = abbreviated ? (row.abbreviatedLabel ?? row.label) : row.label;
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
          {label}
        </span>
        <span
          data-testid={`usage-percent-${row.key}`}
          style={{
            color: "var(--text-secondary)",
            fontSize: density.labelFontSize,
            fontWeight: 600,
          }}
        >
          {row.percent == null ? "--" : `${row.percent}%`}
        </span>
      </div>
      <Meter
        percent={row.percent}
        color={colors.used}
        track={colors.track}
        testId={`usage-meter-used-${row.key}`}
        height={density.usedMeterHeight}
      />
      {detailed && row.elapsed != null && (
        <Meter
          percent={row.elapsed}
          color={colors.pace}
          track={colors.track}
          testId={`usage-meter-pace-${row.key}`}
          height={PACE_METER_HEIGHT}
        />
      )}
      {detailed && density.showDetailText && (row.reset || row.elapsed != null) && (
        <div
          data-testid={`usage-detail-${row.key}`}
          className="flex min-w-0 items-baseline justify-between gap-2"
        >
          <span
            className="truncate"
            style={{ color: "var(--text-secondary)", fontSize: "var(--fs-xs)" }}
          >
            {row.reset ? `${abbreviated ? "" : "Resets "}${row.reset}` : "Reset unavailable"}
          </span>
          {row.elapsed != null && (
            <span className="shrink-0" style={{ color: colors.pace, fontSize: "var(--fs-xs)" }}>
              {row.elapsed}%{abbreviated ? "" : " elapsed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CompactRows({
  rows,
  colors,
}: {
  rows: UsageDisplayRow[];
  colors: { used: string; pace: string; track: string };
}) {
  return (
    <div className="flex h-full min-w-0 flex-row items-center gap-1 p-2">
      {rows.map((row) => (
        <div
          key={row.key}
          data-testid={`usage-row-${row.key}`}
          className="flex min-w-0 flex-1 flex-col gap-1"
        >
          <Meter
            percent={row.percent}
            color={colors.used}
            track={colors.track}
            testId={`usage-meter-used-${row.key}`}
            height={PACE_METER_HEIGHT}
          />
          <Meter
            percent={row.elapsed}
            color={colors.pace}
            track={colors.track}
            testId={`usage-meter-pace-${row.key}`}
            height={PACE_METER_HEIGHT}
          />
        </div>
      ))}
    </div>
  );
}

/** Shared provider-neutral usage surface. Keep every visual rule here. */
export function UsagePresentation({
  title,
  plan,
  model,
  configDir = "",
  rows,
  message,
  capturedAtMs,
  refresh,
  refreshTitle,
  paneId,
  fontFamily,
  colors,
}: {
  title: string;
  plan: string | null;
  model?: string | null;
  configDir?: string;
  rows: UsageDisplayRow[];
  message: string | null;
  capturedAtMs: number | null;
  refresh: () => void;
  /** Tooltip for the refresh button. Provider-specific, so the caller owns it. */
  refreshTitle: string;
  paneId?: string;
  fontFamily: string;
  /** Owned per provider, so the caller passes its agent's palette. */
  colors: { used: string; pace: string; track: string };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(containerRef);
  const preference = useOverridesStore((s) =>
    paneId ? s.viewOverrides[paneId]?.usageLayout : undefined,
  );
  const setViewOverride = useOverridesStore((s) => s.setViewOverride);
  const layout = resolveUsageLayout(
    { width: size.w, height: size.h },
    preference ?? "auto",
    rows.length,
  );
  const density = resolveUsageDensity(size.h, rows.length);
  const abbreviated =
    (layout === "columns" ? size.w / Math.max(1, rows.length) : size.w) < ABBREVIATED_ROW_MAX_WIDTH;
  const capturedLabel =
    capturedAtMs == null
      ? "never"
      : new Date(capturedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const cycleLayout = () => {
    if (paneId) {
      const current = preference ?? "auto";
      setViewOverride(paneId, {
        usageLayout: LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(current) + 1) % LAYOUT_CYCLE.length],
      });
    }
  };
  const detailed = showsDetail(layout);
  return (
    <ViewShell testId="usage-view" style={{ fontFamily }}>
      <ViewHeader testId="usage-header" title={title}>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2">
          {plan && (
            <span
              data-testid="usage-plan"
              className="truncate"
              style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}
            >
              {plan}
              {model ? ` · ${model}` : ""}
            </span>
          )}
          {configDir && (
            // Truncated on purpose, so the tooltip is the only way to read a
            // long account path — required once several accounts are monitored.
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
          title={refreshTitle}
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
            <CompactRows rows={rows} colors={colors} />
          ) : (
            <div
              data-testid="usage-content"
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
            >
              {rows.map((row) => (
                <RowBlock
                  key={row.key}
                  row={row}
                  detailed={detailed}
                  abbreviated={abbreviated}
                  density={density}
                  colors={colors}
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

export function UsageView({ configDir = "", paneId }: UsageViewProps) {
  const now = useNowTick(TICK_MS);
  const { snapshot, error, refresh } = useUsageSnapshot(`usage-${paneId ?? "dock"}`, configDir);
  const visibleRows = useSettingsStore((s) => s.usage.claude.visibleRows);
  const colors = useSettingsStore((s) => s.usage.claude.colors);
  const fontFamily = useSettingsStore((s) => {
    const font = s.resolveFont(s.usage.claude.profile || s.defaultProfile);
    return `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
  });
  const rows = useMemo(
    () => selectVisibleRows(buildClaudeUsageRows(snapshot, now), visibleRows),
    [snapshot, now, visibleRows],
  );
  return (
    <UsagePresentation
      title="Claude Usage"
      refreshTitle="Query /usage now"
      plan={snapshot.plan}
      model={snapshot.model}
      configDir={configDir}
      rows={rows}
      message={error ?? claudeUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      refresh={refresh}
      paneId={paneId}
      fontFamily={fontFamily}
      colors={colors}
    />
  );
}
