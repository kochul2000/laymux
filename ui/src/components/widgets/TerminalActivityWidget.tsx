import { useTranslation } from "react-i18next";
import { isTerminalBusy } from "@/lib/terminal-busy";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";
import { readTerminalActivityScope } from "./widget-options";

export function TerminalActivityWidget({ instance, dragRegion }: WidgetComponentProps) {
  const { t } = useTranslation("settings");
  const scope = readTerminalActivityScope(instance.options);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const instances = useTerminalStore((s) => s.instances);

  const counted =
    scope === "all"
      ? instances
      : instances.filter((terminal) => terminal.workspaceId === activeWorkspaceId);
  const busy = counted.filter(isTerminalBusy).length;

  return (
    <WidgetChrome
      testId={`widget-terminal-activity-${instance.id}`}
      dragRegion={dragRegion}
      title={t(scope === "all" ? "widgets.activityBusyAll" : "widgets.activityBusyWorkspace", {
        busy,
        total: counted.length,
      })}
    >
      <span style={{ color: busy > 0 ? "var(--accent)" : "var(--text-muted)" }}>●</span>
      <span data-testid={`widget-terminal-activity-${instance.id}-count`}>
        {busy}
        <WidgetLabel>{` / ${counted.length}`}</WidgetLabel>
      </span>
    </WidgetChrome>
  );
}
