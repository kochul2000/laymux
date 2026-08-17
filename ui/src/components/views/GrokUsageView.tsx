import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { buildGrokUsageRows, selectVisibleRows, type UsageDisplayRow } from "@/lib/usage-rows";
import { grokUsageStatusMessage } from "@/lib/usage-status";
import { useGrokUsageSnapshot } from "@/hooks/useGrokUsageSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { UsagePresentation } from "./UsageView";

const TICK_MS = 30_000;

export function GrokUsageView({
  paneId,
  configDir = "",
}: {
  paneId?: string;
  configDir?: string;
}) {
  const now = useNowTick(TICK_MS);
  const usage = useSettingsStore((s) => s.usage.grok);
  const { snapshot, error, refresh } = useGrokUsageSnapshot(
    paneId ? `grok-view-${paneId}` : "grok-view",
    configDir,
  );
  const fontFamily = useSettingsStore((s) => {
    const font = s.resolveFont(usage.profile || s.defaultProfile);
    return `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
  });

  const rows = useMemo<UsageDisplayRow[]>(
    () => selectVisibleRows(buildGrokUsageRows(snapshot.rows, now), usage.visibleRows),
    [snapshot.rows, now, usage.visibleRows],
  );

  return (
    <UsagePresentation
      title="Grok Usage"
      plan={null}
      configDir={configDir}
      rows={rows}
      message={error ?? grokUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      refresh={refresh}
      refreshTitle="Read Grok usage now"
      paneId={paneId}
      fontFamily={fontFamily}
      colors={usage.colors}
    />
  );
}
