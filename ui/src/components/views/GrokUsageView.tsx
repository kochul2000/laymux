import { useCallback, useEffect, useMemo, useState } from "react";
import { getGrokUsageSnapshot } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { buildGrokUsageRows, selectVisibleRows, type UsageDisplayRow } from "@/lib/usage-rows";
import { UsagePresentation } from "./UsageView";

interface GrokUsageSnapshotState {
  status: string;
  rows: { key: string; percent: number | null; reset: string | null }[];
  capturedAtMs: number | null;
  message: string | null;
}

const IDLE: GrokUsageSnapshotState = {
  status: "idle",
  rows: [],
  capturedAtMs: null,
  message: null,
};

export function GrokUsageView({
  paneId,
  configDir = "",
}: {
  paneId?: string;
  configDir?: string;
}) {
  const usage = useSettingsStore((s) => s.usage.grok);
  const [snapshot, setSnapshot] = useState<GrokUsageSnapshotState>(IDLE);
  const fontFamily = useSettingsStore((s) => {
    const font = s.resolveFont(usage.profile || s.defaultProfile);
    return `'${font.face}', 'Cascadia Mono', 'Consolas', monospace`;
  });

  const refresh = useCallback(() => {
    void getGrokUsageSnapshot(configDir)
      .then((next) =>
        setSnapshot({
          status: next.status,
          rows: next.rows.map((row) => ({
            key: row.key,
            percent: row.percent ?? null,
            reset: row.reset ?? null,
          })),
          capturedAtMs: next.capturedAtMs ?? null,
          message: next.message ?? null,
        }),
      )
      .catch(() => setSnapshot(IDLE));
  }, [configDir]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, Math.max(usage.refreshSeconds, 600) * 1000);
    return () => window.clearInterval(id);
  }, [refresh, usage.refreshSeconds]);

  const rows = useMemo<UsageDisplayRow[]>(
    () => selectVisibleRows(buildGrokUsageRows(snapshot.rows), usage.visibleRows),
    [snapshot.rows, usage.visibleRows],
  );

  return (
    <UsagePresentation
      title="Grok Usage"
      plan={null}
      configDir={configDir}
      rows={rows}
      message={snapshot.message ?? (snapshot.status === "idle" ? "No Grok usage probe is running." : null)}
      capturedAtMs={snapshot.capturedAtMs}
      refresh={refresh}
      refreshTitle="Read Grok usage now"
      paneId={paneId}
      fontFamily={fontFamily}
      colors={usage.colors}
    />
  );
}
