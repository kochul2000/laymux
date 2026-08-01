import { useMemo } from "react";
import { useCodexUsageSnapshot } from "@/hooks/useCodexUsageSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { buildCodexUsageRows, selectVisibleRows } from "@/lib/usage-rows";
import { codexUsageStatusMessage } from "@/lib/usage-status";
import { UsageWidgetBody } from "./UsageWidgetBody";
import { readDisplay } from "./widget-options";
import type { WidgetComponentProps } from "./types";

const TICK_MS = 30_000;

/** Codex usage on one line. Polls at the shared `usage.codex.refreshSeconds`. */
export function CodexUsageWidget({ instance }: WidgetComponentProps) {
  const now = useNowTick(TICK_MS);
  const usage = useSettingsStore((s) => s.usage.codex);
  const { snapshot } = useCodexUsageSnapshot(usage.refreshSeconds);
  const rows = useMemo(
    () => selectVisibleRows(buildCodexUsageRows(snapshot.limits, now), usage.visibleRows),
    [snapshot.limits, now, usage.visibleRows],
  );

  return (
    <UsageWidgetBody
      testId={`widget-codex-usage-${instance.id}`}
      label="Codex"
      rows={rows}
      display={readDisplay(instance.options)}
      message={codexUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
    />
  );
}
