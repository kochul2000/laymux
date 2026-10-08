import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore, FALLBACK_PROFILE } from "@/stores/settings-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { layerEntries } from "./pane-layers";

/** A renderer can disappear while its declared terminal content remains alive. */
export function preserveTerminalSourceOnUnmount(
  paneId: string | undefined,
  profile: string,
  mountedRestartEpoch: number,
): boolean {
  if (!paneId) return false;
  if ((useTerminalRestartStore.getState().requests[paneId]?.epoch ?? 0) !== mountedRestartEpoch)
    return false;
  const workspaceView = useWorkspaceStore
    .getState()
    .workspaces.flatMap((workspace) => layerEntries(workspace.panes))
    .find(({ layer }) => layer.id === paneId)?.layer.view;
  const view =
    workspaceView ??
    useDockStore
      .getState()
      .docks.flatMap((dock) => dock.panes)
      .find((pane) => pane.id === paneId)?.view;
  if (view?.type !== "TerminalView") return false;
  const configuredProfile = typeof view.profile === "string" ? view.profile : "";
  return (
    (configuredProfile || useSettingsStore.getState().defaultProfile || FALLBACK_PROFILE) ===
    profile
  );
}

export function terminalRestartEpoch(paneId: string | undefined): number {
  return paneId ? (useTerminalRestartStore.getState().requests[paneId]?.epoch ?? 0) : 0;
}
