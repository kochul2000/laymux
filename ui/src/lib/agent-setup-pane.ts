import { focusWorkspacePane } from "./workspace-transition";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { AgentStartupIntent } from "@/stores/agent-startup-store";
import { useGridStore } from "@/stores/grid-store";

/** Add a terminal beside the current pane without replacing any existing view. */
export function openAgentSetupPane(profileName: string, intent: AgentStartupIntent): string | null {
  const store = useWorkspaceStore.getState();
  const workspace = store.getActiveWorkspace();
  if (!workspace?.panes.length) return null;
  const focusedIndex = useGridStore.getState().focusedPaneIndex;
  const focused = focusedIndex !== null && workspace.panes[focusedIndex] ? focusedIndex : 0;
  store.splitPane(focused, "vertical");
  const updated = useWorkspaceStore.getState().getActiveWorkspace();
  const pane = updated?.panes[focused + 1];
  if (!pane) return null;
  useWorkspaceStore.getState().setPaneView(
    focused + 1,
    {
      type: "TerminalView",
      profile: profileName,
    },
    intent,
  );
  focusWorkspacePane(workspace.id, focused + 1);
  return pane.id;
}
