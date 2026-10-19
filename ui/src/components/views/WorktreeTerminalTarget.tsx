import { useSettingsStore } from "@/stores/settings-store";
import type { useWorktreeTerminalTargets } from "@/hooks/useWorktreeTerminalTargets";
import { WorkspaceIdentity } from "./workspace-selector/WorkspaceIdentity";
import { WorkspaceTerminalSummary } from "./workspace-selector/WorkspaceTerminalSummary";

export function WorktreeTerminalTarget({
  target,
}: {
  target: ReturnType<typeof useWorktreeTerminalTargets>[number];
}) {
  const pathEllipsis = useSettingsStore((s) => s.workspaceSelector.pathEllipsis);
  return (
    <span className="worktree-terminal-target">
      <WorkspaceIdentity index={target.index} name={target.name} isActive={target.isFocusedPane} />
      <WorkspaceTerminalSummary
        terminal={target.terminal}
        minimapPanes={target.panes}
        paneIndex={target.paneIndex}
        isActive={target.isFocusedPane}
        isFocusedPane={target.isFocusedPane}
        pathEllipsis={pathEllipsis}
      />
    </span>
  );
}
