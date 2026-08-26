import { useTranslation } from "react-i18next";
import { isTerminalWorking } from "@/lib/terminal-working";
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
  const busy = counted.filter(isTerminalWorking).length;

  return (
    <WidgetChrome
      testId={`widget-terminal-activity-${instance.id}`}
      dragRegion={dragRegion}
      title={t(scope === "all" ? "widgets.activityBusyAll" : "widgets.activityBusyWorkspace", {
        busy,
        total: counted.length,
      })}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: busy > 0 ? "var(--accent)" : "var(--text-muted)" }}
      />
      <span data-testid={`widget-terminal-activity-${instance.id}-count`}>
        {busy}
        <WidgetLabel>{` / ${counted.length}`}</WidgetLabel>
      </span>
    </WidgetChrome>
  );
}
