import { useCallback, useEffect, useMemo, useState } from "react";
import { getGrokUsageSnapshot } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { buildGrokUsageRows, selectVisibleRows } from "@/lib/usage-rows";
import { UsageWidgetBody, type UsageWidgetDisplay } from "./UsageWidgetBody";
import type { WidgetRenderProps } from "./types";

export function GrokUsageWidget({ instance }: WidgetRenderProps) {
  const usage = useSettingsStore((s) => s.usage.grok);
  const configDir = typeof instance.options.configDir === "string" ? instance.options.configDir : "";
  const display = (instance.options.display as UsageWidgetDisplay | undefined) ?? "both";
  const [rows, setRows] = useState(buildGrokUsageRows([]));

  const refresh = useCallback(() => {
    void getGrokUsageSnapshot(configDir).then((snapshot) => {
      setRows(
        buildGrokUsageRows(
          snapshot.rows.map((row) => ({
            key: row.key,
            percent: row.percent ?? null,
            reset: row.reset ?? null,
          })),
        ),
      );
    });
  }, [configDir]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, Math.max(usage.refreshSeconds, 600) * 1000);
    return () => window.clearInterval(id);
  }, [refresh, usage.refreshSeconds]);

  const visible = useMemo(
    () => selectVisibleRows(rows, usage.visibleRows),
    [rows, usage.visibleRows],
  );

  return (
    <UsageWidgetBody
      rows={visible}
      display={display}
      colors={usage.colors}
      options={instance.options}
    />
  );
}
