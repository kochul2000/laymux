import { useMemo } from "react";
import { useCodexUsageSnapshot } from "@/hooks/useCodexUsageSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { buildCodexUsageRows, selectVisibleRows, type UsageDisplayRow } from "@/lib/usage-rows";
import { codexUsageStatusMessage } from "@/lib/usage-status";
import { UsagePresentation } from "./UsageView";

const TICK_MS = 30_000;

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
    () => selectVisibleRows(buildCodexUsageRows(snapshot.limits, now), usage.visibleRows),
    [snapshot.limits, now, usage.visibleRows],
  );
  return (
    <UsagePresentation
      title="Codex Usage"
      plan={snapshot.plan}
      configDir={configDir}
      rows={rows}
      message={codexUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      refresh={refresh}
      refreshTitle="Read Codex rate limits now"
      paneId={paneId}
      fontFamily={fontFamily}
    />
  );
}
