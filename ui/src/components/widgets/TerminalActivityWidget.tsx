import { useTranslation } from "react-i18next";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";
import { readTerminalActivityScope } from "./widget-options";

/**
 * A terminal counts as busy while a command runs or output is still flowing.
 *
 * Deliberately not `ActivityHandler.isBusy` (ADR-0113) even though the shell
 * rule is identical: that predicate answers "would typing land somewhere other
 * than an empty prompt", so it counts an open permission modal as busy. Here
 * the modal is the opposite — the terminal is waiting on the user, not working.
 */
function isBusy(instance: TerminalInstance): boolean {
  return instance.activity?.type === "running" || instance.outputActive === true;
}

export function TerminalActivityWidget({ instance, dragRegion }: WidgetComponentProps) {
  const { t } = useTranslation("settings");
  const scope = readTerminalActivityScope(instance.options);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const instances = useTerminalStore((s) => s.instances);

  const counted =
    scope === "all"
      ? instances
      : instances.filter((terminal) => terminal.workspaceId === activeWorkspaceId);
  const busy = counted.filter(isBusy).length;

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
