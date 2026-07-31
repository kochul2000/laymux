import { useMemo, useRef } from "react";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useNowTick, useUsageSnapshot } from "@/hooks/useUsageSnapshot";
import { useOverridesStore } from "@/stores/overrides-store";
import {
  resolveUsageLayout,
  showsDetail,
  type UsageLayout,
  type UsageLayoutPreference,
} from "@/lib/usage-layout";
import {
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  formatTimeUntil,
  paceVerdict,
  sessionElapsedPercent,
  weekElapsedPercent,
  type PaceVerdict,
} from "@/lib/usage-pace";
import type { UsageLimit, UsageProbeStatus, UsageSnapshot } from "@/lib/tauri-api";

/** Pace and countdowns are time-derived, so re-render on a slow tick. */
const TICK_MS = 30_000;

interface UsageViewProps {
  /** `CLAUDE_CONFIG_DIR` to monitor. Empty = default config dir. */
  configDir?: string;
  /** View-instance key for the layout override (localStorage). */
  paneId?: string;
}

/** One limit row, resolved for display. */
interface Row {
  key: string;
  label: string;
  limit: UsageLimit;
  /** Elapsed percentage of this row's billing window, when derivable. */
  elapsed: number | null;
  /** Time until this row resets. */
  remaining: string | null;
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

const VERDICT_COLOR: Record<PaceVerdict, string> = {
  ahead: "var(--red)",
  onTrack: "var(--text-secondary)",
  behind: "var(--green)",
  unknown: "var(--text-muted)",
};

function buildRows(snapshot: UsageSnapshot, now: Date): Row[] {
  return [
    {
      key: "session",
      label: "Current session",
      limit: snapshot.session,
      elapsed: sessionElapsedPercent(snapshot.session.reset, now),
      remaining: formatTimeUntil(snapshot.session.reset, SESSION_WINDOW_MS, now),
    },
    {
      key: "week-all",
      label: "Current week (all models)",
      limit: snapshot.weekAll,
      elapsed: weekElapsedPercent(snapshot.weekAll.reset, now),
      remaining: formatTimeUntil(snapshot.weekAll.reset, WEEK_WINDOW_MS, now),
    },
    {
      key: "week-model",
      // The label comes from the panel, which names this row after the account's
      // model. Falling back to a generic title is better than naming a model the
      // account may not be on.
      label: snapshot.weekModelLabel
        ? `Current week (${snapshot.weekModelLabel})`
        : "Current week (per model)",
      limit: snapshot.weekModel,
      elapsed: weekElapsedPercent(snapshot.weekModel.reset, now),
      remaining: formatTimeUntil(snapshot.weekModel.reset, WEEK_WINDOW_MS, now),
    },
  ];
}

/** Fixed-height meter. Renders an empty track when the value is unknown. */
function Meter({ percent, color }: { percent: number | null; color: string }) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div
      className="w-full overflow-hidden"
      style={{
        height: "6px",
        borderRadius: "var(--radius-sm)",
        background: "var(--usage-track)",
      }}
    >
      <div style={{ width: `${width}%`, height: "100%", background: color }} />
    </div>
  );
}

function RowBlock({ row, detailed }: { row: Row; detailed: boolean }) {
  const used = row.limit.percent;
  const verdict = paceVerdict(used, row.elapsed);

  return (
    <div data-testid={`usage-row-${row.key}`} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span
          className="truncate"
          style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", fontWeight: 600 }}
        >
          {row.label}
        </span>
        <span
          data-testid={`usage-percent-${row.key}`}
          style={{ color: "var(--text-primary)", fontSize: "var(--fs-md)", fontWeight: 600 }}
        >
          {used == null ? "--" : `${used}%`}
        </span>
      </div>

      <Meter percent={used} color="var(--usage-used)" />

      {detailed && row.elapsed != null && (
        <>
          <Meter percent={row.elapsed} color="var(--usage-pace)" />
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span style={{ color: VERDICT_COLOR[verdict], fontSize: "var(--fs-xs)" }}>
              {row.elapsed}% elapsed
            </span>
            {row.remaining && (
              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                resets in {row.remaining}
              </span>
            )}
          </div>
        </>
      )}

      {detailed && row.elapsed == null && row.limit.reset && (
        <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
          Resets {row.limit.reset}
        </span>
      )}
    </div>
  );
}

function CompactRow({ rows }: { rows: Row[] }) {
  return (
    <div className="flex h-full min-w-0 items-center gap-3 overflow-x-auto px-2">
      {rows.map((row) => {
        const used = row.limit.percent;
        const verdict = paceVerdict(used, row.elapsed);
        return (
          <div
            key={row.key}
            data-testid={`usage-row-${row.key}`}
            className="flex min-w-0 shrink-0 items-center gap-1.5"
          >
            <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
              {compactLabel(row)}
            </span>
            <span
              data-testid={`usage-percent-${row.key}`}
              style={{ color: VERDICT_COLOR[verdict], fontSize: "var(--fs-md)", fontWeight: 600 }}
            >
              {used == null ? "--" : `${used}%`}
            </span>
            {row.elapsed != null && (
              <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-2xs)" }}>
                /{row.elapsed}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function compactLabel(row: Row): string {
  if (row.key === "session") return "session";
  if (row.key === "week-all") return "week";
  return "model";
}

const LAYOUT_CYCLE: UsageLayoutPreference[] = ["auto", "stacked", "columns", "compact"];

/** Widest a single column grows to before the block stops expanding. */
const MAX_COLUMN_WIDTH = 340;

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

  const layout: UsageLayout = resolveUsageLayout(
    { width: size.w, height: size.h },
    preference ?? "auto",
  );
  const detailed = showsDetail(layout);

  const rows = useMemo(() => buildRows(snapshot, now), [snapshot, now]);
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
    <ViewShell testId="usage-view">
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
          className="hover-bg-strong shrink-0 cursor-pointer rounded px-1.5"
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
          className="hover-bg-strong shrink-0 cursor-pointer rounded px-1.5"
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
          className="flex h-full w-full flex-col overflow-auto"
          style={{ background: "var(--bg-base)" }}
        >
          {layout === "compact" ? (
            <CompactRow rows={rows} />
          ) : (
            // `my-auto` centers the block when the pane is taller than the
            // content and collapses to no-op when it is not, so a tall tile does
            // not leave the meters clinging to its top edge.
            <div
              className={
                layout === "columns"
                  ? "mx-auto my-auto grid w-full gap-4 p-3"
                  : "mx-auto my-auto flex w-full flex-col gap-4 p-3"
              }
              style={{
                // Meters stop being readable long before they stop fitting: on a
                // very wide pane a full-bleed row pushes its label and its number
                // to opposite edges. Cap the block and center it instead.
                maxWidth: layout === "columns" ? `${MAX_COLUMN_WIDTH * rows.length}px` : "720px",
                ...(layout === "columns"
                  ? { gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }
                  : {}),
              }}
            >
              {rows.map((row) => (
                <RowBlock key={row.key} row={row} detailed={detailed} />
              ))}
            </div>
          )}

          {detailed && (
            <div
              data-testid="usage-footer"
              className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2"
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
