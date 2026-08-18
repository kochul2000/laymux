import { useMemo } from "react";
import { useGrokUsageSnapshot } from "@/hooks/useGrokUsageSnapshot";
import { useNowTick } from "@/hooks/useUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { buildGrokUsageRows, selectVisibleRows } from "@/lib/usage-rows";
import { grokUsageStatusMessage } from "@/lib/usage-status";
import { UsageWidgetBody } from "./UsageWidgetBody";
import { readBarHeight, readBarWidth, readDisplay, readElapsedHeight } from "./widget-options";
import type { WidgetComponentProps } from "./types";

const TICK_MS = 30_000;

export function GrokUsageWidget({ instance, dragRegion }: WidgetComponentProps) {
  const configDir =
    typeof instance.options.configDir === "string" ? instance.options.configDir : "";
  const now = useNowTick(TICK_MS);
  const { snapshot, error } = useGrokUsageSnapshot(`widget-${instance.id}`, configDir);
  const visibleRows = useSettingsStore((s) => s.usage.grok.visibleRows);
  const colors = useSettingsStore((s) => s.usage.grok.colors);
  const rows = useMemo(
    () => selectVisibleRows(buildGrokUsageRows(snapshot.rows, now), visibleRows),
    [snapshot.rows, now, visibleRows],
  );

  return (
    <UsageWidgetBody
      testId={`widget-grok-usage-${instance.id}`}
      label="Grok"
      rows={rows}
      display={readDisplay(instance.options)}
      colors={colors}
      usedHeight={readBarHeight(instance.options)}
      elapsedHeight={readElapsedHeight(instance.options)}
      barWidth={readBarWidth(instance.options)}
      message={error ?? grokUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      configDir={configDir}
      dragRegion={dragRegion}
    />
  );
}
