import type { WorktreeUsage } from "./worktree-api";
import { activatePaneLayer, focusDockPane } from "./workspace-transition";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { worktreeTerminalCwd, worktreeTerminalProfile } from "./worktree-terminal-profile";

/** Reveal hidden content before committing focus through the shared transition owner. */
export function focusWorktreeUsage(usage: WorktreeUsage): boolean {
  if (!usage.paneId) return false;
  const paneId = usage.paneId;
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((item) =>
      item.panes.some((slot) => slot.layers.some((layer) => layer.id === paneId)),
    );
  if (workspace) {
    useUiStore.getState().setWorkspaceHidden(workspace.id, false);
    useUiStore.getState().setPaneHidden(paneId, false);
    return activatePaneLayer(workspace.id, paneId);
  }
  const dockState = useDockStore.getState();
  const dock = dockState.docks.find((item) => item.panes.some((pane) => pane.id === paneId));
  if (!dock) return false;
  if (!dock.visible) dockState.toggleDockVisible(dock.position);
  return focusDockPane(dock.position, paneId);
}

/** Add a fresh terminal layer; the explicit CWD seed also works with session restore disabled. */
export function openWorktreeTerminal(path: string, sourcePaneId?: string): string | null {
  const { profiles, defaultProfile } = useSettingsStore.getState();
  const profile = worktreeTerminalProfile(
    path,
    profiles,
    defaultProfile,
    useTerminalStore.getState().instances,
  );
  if (!profile)
    throw new Error(
      "이 WSL 배포판에 연결된 터미널이나 명시적 배포판 프로필이 필요합니다. 설정에서 해당 배포판의 터미널 프로필을 추가해 주세요.",
    );
  const cwd = worktreeTerminalCwd(path);
  const state = useWorkspaceStore.getState();
  const workspace = state.getActiveWorkspace();
  if (!workspace?.panes.length) return null;
  const source = workspace.panes.findIndex((slot) =>
    slot.layers.some((layer) => layer.id === sourcePaneId),
  );
  const focused = useGridStore.getState().focusedPaneIndex;
  const paneIndex =
    source >= 0 ? source : focused !== null && workspace.panes[focused] ? focused : 0;
  const id = state.stackPane(
    paneIndex,
    {
      type: "TerminalView",
      profile,
      lastCwd: cwd,
      syncGroup: "none",
      cwdSend: false,
      cwdReceive: false,
    },
    { activate: false },
  );
  if (!id) return null;
  useTerminalRestartStore.getState().requestRestart(id, cwd);
  useUiStore.getState().setWorkspaceHidden(workspace.id, false);
  return activatePaneLayer(workspace.id, id) ? id : null;
}
