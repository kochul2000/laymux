import { useMemo } from "react";
import { useNowTick, useUsageSnapshot } from "@/hooks/useUsageSnapshot";
import { useSettingsStore } from "@/stores/settings-store";
import { buildClaudeUsageRows, selectVisibleRows } from "@/lib/usage-rows";
import { claudeUsageStatusMessage } from "@/lib/usage-status";
import { UsageWidgetBody } from "./UsageWidgetBody";
import { readDisplay } from "./widget-options";
import type { WidgetComponentProps } from "./types";

const TICK_MS = 30_000;

/**
 * Claude usage on one line.
 *
 * Subscribes through the same hook a UsageView uses, so the widget is ordinary
 * demand for the probe and shares its interval — no widget-only polling tier
 * (ADR-0105).
 */
export function ClaudeUsageWidget({ instance }: WidgetComponentProps) {
  const configDir =
    typeof instance.options.configDir === "string" ? instance.options.configDir : "";
  const now = useNowTick(TICK_MS);
  const { snapshot, error } = useUsageSnapshot(`widget-${instance.id}`, configDir);
  const visibleRows = useSettingsStore((s) => s.usage.claude.visibleRows);
  const rows = useMemo(
    () => selectVisibleRows(buildClaudeUsageRows(snapshot, now), visibleRows),
    [snapshot, now, visibleRows],
  );

  return (
    <UsageWidgetBody
      testId={`widget-claude-usage-${instance.id}`}
      label="Claude"
      rows={rows}
      display={readDisplay(instance.options)}
      message={error ?? claudeUsageStatusMessage(snapshot.status)}
      capturedAtMs={snapshot.capturedAtMs}
      configDir={configDir}
    />
  );
}
