import { useMemo } from "react";
import { useCodexUsageSnapshot } from "@/hooks/useCodexUsageSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { selectVisibleRows, type UsageDisplayRow } from "@/lib/usage-rows";
import { UsagePresentation } from "./UsageView";
import type { CodexUsageStatus } from "@/lib/tauri-api";

const TICK_MS = 30_000;

function statusMessage(status: CodexUsageStatus): string | null {
  if (status.type === "ready") return null;
  if (status.type === "codexMissing") return "`codex` not found on PATH";
  if (status.type === "unauthorized") return "Sign in to Codex CLI to read usage";
  return status.message;
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

function isSparkLimit(key: string, label: string): boolean {
  return /spark/i.test(`${key} ${label}`);
}

export function CodexUsageView({
  paneId,
  configDir = "",
}: {
  paneId?: string;
  configDir?: string;
}) {
  const now = useNowTick(TICK_MS);
  const usage = useSettingsStore((s) => s.usage.codex);
  const { snapshot, refresh } = useCodexUsageSnapshot(usage.refreshSeconds, configDir);
  const fontFamily = useSettingsStore((s) => {
    const font = s.resolveFont(usage.profile || s.defaultProfile);
    return `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
  });
  const rows = useMemo<UsageDisplayRow[]>(
    () =>
      selectVisibleRows(
        snapshot.limits
          // Codex exposes a primary window per quota family. The secondary window
          // is a nested horizon of the same quota, not the separate Spark limit
          // users select in this view.
          .filter((limit) => limit.kind === "primary")
          .map((limit) => {
            const spark = isSparkLimit(limit.key, limit.label);
            const totalMs = limit.windowDurationMins * 60_000;
            const startMs = limit.resetsAtSecs * 1000 - totalMs;
            const elapsed =
              totalMs > 0
                ? Math.max(
                    0,
                    Math.min(100, Math.round(((now.getTime() - startMs) / totalMs) * 100)),
                  )
                : null;
            return {
              visibleKey: spark ? ("sparkWeekly" as const) : ("weekly" as const),
              row: {
                key: limit.key,
                label: spark ? "Spark Weekly limit" : "Weekly limit",
                abbreviatedLabel: spark ? "Spark" : "Weekly",
                percent: limit.usedPercent,
                reset: resetText(limit.resetsAtSecs),
                elapsed,
              },
            };
          }),
        usage.visibleRows,
      ),
    [snapshot.limits, now, usage.visibleRows],
  );
  return (
    <UsagePresentation
      title="Codex Usage"
      plan={snapshot.plan}
      configDir={configDir}
      rows={rows}
      message={statusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      refresh={refresh}
      refreshTitle="Read Codex rate limits now"
      paneId={paneId}
      fontFamily={fontFamily}
    />
  );
}
