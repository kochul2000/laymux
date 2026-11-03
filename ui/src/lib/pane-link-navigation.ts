import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useUiStore } from "@/stores/ui-store";
import { computePaneNumbers } from "./pane-numbers";
import { layerEntries } from "./pane-layers";
import { resolvePaneLink, type PaneLinkTarget } from "./pane-link";
import { activatePaneLayer } from "./workspace-transition";
import { getPaneInstanceId } from "./view-instance-id";

/** 현재 레이아웃이 정본이다. 아직 PTY가 시작되지 않은 숨은 레이어도 해석한다. */
export function resolveDesktopPaneLink(text: string): PaneLinkTarget | null {
  if (!useSettingsStore.getState().terminal.paneLinkEnabled) return null;
  const { workspaces, pendingWorkspaceCloses } = useWorkspaceStore.getState();
  return resolvePaneLink(
    text,
    workspaces
      .filter((workspace) => !pendingWorkspaceCloses.some((pending) => pending.id === workspace.id))
      .map((workspace) => {
        const numbers = computePaneNumbers(workspace.panes);
        return {
          id: workspace.id,
          name: workspace.name,
          panes: layerEntries(workspace.panes).map(({ layer }) => ({
            id: layer.id,
            terminalId: layer.view.type === "TerminalView" ? getPaneInstanceId(layer) : null,
            paneNumber: numbers.get(layer.id),
          })),
        };
      }),
  );
}

export function focusDesktopPaneLink(target: PaneLinkTarget): boolean {
  const current = resolveDesktopPaneLink(target.terminalId);
  if (!current || current.workspaceId !== target.workspaceId || !current.workspaceId) return false;
  if (!activatePaneLayer(current.workspaceId, current.paneId)) return false;
  useUiStore.getState().setWorkspaceHidden(current.workspaceId, false);
  useUiStore.getState().setPaneHidden(current.paneId, false);
  useTerminalStore.getState().setTerminalFocus(current.terminalId);
  return true;
}
