import { useMemo } from "react";
import { useGrokUsageSnapshot } from "@/hooks/useGrokUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { buildGrokUsageRows, selectVisibleRows } from "@/lib/usage-rows";
import { grokUsageStatusMessage } from "@/lib/usage-status";
import { UsageWidgetBody } from "./UsageWidgetBody";
import { readBarHeight, readBarWidth, readDisplay, readElapsedHeight } from "./widget-options";
import type { WidgetComponentProps } from "./types";

export function GrokUsageWidget({ instance, dragRegion }: WidgetComponentProps) {
  const configDir =
    typeof instance.options.configDir === "string" ? instance.options.configDir : "";
  const { snapshot, error } = useGrokUsageSnapshot(`widget-${instance.id}`, configDir);
  const visibleRows = useSettingsStore((s) => s.usage.grok.visibleRows);
  const colors = useSettingsStore((s) => s.usage.grok.colors);
  const rows = useMemo(
    () => selectVisibleRows(buildGrokUsageRows(snapshot.rows), visibleRows),
    [snapshot.rows, visibleRows],
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
