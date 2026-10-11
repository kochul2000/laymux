import { invoke } from "@tauri-apps/api/core";
import type { TerminalAttributionCoverage } from "./settings-snapshot";
import type { Settings } from "./tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";

export interface LocalSessionSnapshot {
  workspaces: Settings["workspaces"];
  docks: Settings["docks"];
  workspaceDisplayOrder?: string[];
  coverage: TerminalAttributionCoverage[];
  attributionLookupFailed: boolean;
  cwdLookupFailed: boolean;
  uiState?: {
    activeWorkspaceId?: string;
    fileViewer?: { open: boolean; path: string; maximized: boolean };
  };
}
export interface LocalCheckpointCommit {
  revision: number;
  unresolvedTerminalIds: string[];
  needsRetry: boolean;
  snapshot: LocalSessionSnapshot;
}
export function saveLocalSession(
  settings: Settings,
  coverage: TerminalAttributionCoverage[],
  attributionLookupFailed: boolean,
  cwdLookupFailed: boolean,
): Promise<LocalCheckpointCommit> {
  const viewer = useFileViewerStore.getState();
  const snapshot: LocalSessionSnapshot = {
    workspaces: settings.workspaces,
    docks: settings.docks,
    workspaceDisplayOrder: settings.workspaceDisplayOrder,
    coverage,
    attributionLookupFailed,
    cwdLookupFailed,
    uiState: {
      activeWorkspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      fileViewer: {
        open: viewer.open,
        path: viewer.open ? viewer.path : "",
        maximized: viewer.maximized,
      },
    },
  };
  return invoke("save_session_checkpoint", { snapshot });
}
export function loadLocalSession(): Promise<LocalSessionSnapshot | null> {
  return invoke("load_session_checkpoint");
}
export function applyLocalUiState(
  snapshot: { uiState?: LocalSessionSnapshot["uiState"] } | null | undefined,
): void {
  const active = snapshot?.uiState?.activeWorkspaceId;
  if (active && useWorkspaceStore.getState().workspaces.some((w) => w.id === active))
    useWorkspaceStore.setState({ activeWorkspaceId: active });
  const viewer = snapshot?.uiState?.fileViewer;
  if (viewer?.open && viewer.path)
    useFileViewerStore.getState().openFileViewer(viewer.path, { maximized: viewer.maximized });
}
