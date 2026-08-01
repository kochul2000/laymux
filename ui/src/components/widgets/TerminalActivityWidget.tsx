import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";
import { readTerminalActivityScope } from "./widget-options";

/** A terminal counts as busy while a command runs or output is still flowing. */
function isBusy(instance: TerminalInstance): boolean {
  return instance.activity?.type === "running" || instance.outputActive === true;
}

export function TerminalActivityWidget({ instance }: WidgetComponentProps) {
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
      title={
        scope === "all"
          ? `${busy} of ${counted.length} terminals busy (all workspaces)`
          : `${busy} of ${counted.length} terminals busy (this workspace)`
      }
    >
      <span style={{ color: busy > 0 ? "var(--accent)" : "var(--text-muted)" }}>●</span>
      <span data-testid={`widget-terminal-activity-${instance.id}-count`}>
        {busy}
        <WidgetLabel>{` / ${counted.length}`}</WidgetLabel>
      </span>
    </WidgetChrome>
  );
}
