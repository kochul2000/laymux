import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  collectTerminalStartupCandidates,
  TERMINAL_STARTUP_SLOT_TIMEOUT_MS,
} from "@/lib/terminal-startup-coordinator";
import { useDockStore } from "@/stores/dock-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useGridStore } from "@/stores/grid-store";
import { usePaneRevealStore } from "@/stores/pane-reveal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { resolveViewer, viewerInstanceId } from "@/lib/file-viewer";

/**
 * Own the app-wide terminal startup slot across the active workspace and every
 * visible dock. Call exactly once from AppLayout.
 */
export function useTerminalStartupCoordinator(): void {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const focusedPaneIndex = useGridStore((state) => state.focusedPaneIndex);
  const docks = useDockStore((state) => state.docks);
  const focusedDock = useDockStore((state) => state.focusedDock);
  const focusedDockPaneId = useDockStore((state) => state.focusedDockPaneId);
  const persistHiddenDocks = useSettingsStore((state) => state.dock.persistState);
  const extensionViewers = useSettingsStore((state) => state.fileExplorer.extensionViewers);
  const profiles = useSettingsStore((state) => state.profiles);
  const evictedPaneIds = useUiStore((state) => state.evictedPaneIds);
  const fileViewerOpen = useFileViewerStore((state) => state.open);
  const fileViewerPath = useFileViewerStore((state) => state.path);
  const requestCounts = usePaneRevealStore((state) => state.requestCounts);
  const syncCandidates = useTerminalStartupStore((state) => state.syncCandidates);
  const activePaneId = useTerminalStartupStore((state) => state.activePaneId);

  const requestedPaneIds = useMemo(
    () =>
      Object.entries(requestCounts)
        .filter(([, count]) => count > 0)
        .map(([paneId]) => paneId),
    [requestCounts],
  );

  const foregroundTerminalIds = useMemo(() => {
    if (!fileViewerOpen || !fileViewerPath) return [];
    const resolution = resolveViewer(fileViewerPath, extensionViewers);
    if (
      resolution.viewerType !== "terminal" ||
      !profiles.some((profile) => profile.name === resolution.profile)
    ) {
      return [];
    }
    return [viewerInstanceId(fileViewerPath)];
  }, [extensionViewers, fileViewerOpen, fileViewerPath, profiles]);

  const candidates = useMemo(
    () =>
      collectTerminalStartupCandidates({
        workspaces,
        activeWorkspaceId,
        focusedPaneIndex,
        docks,
        focusedDock,
        focusedDockPaneId,
        persistHiddenDocks,
        evictedPaneIds,
        requestedPaneIds,
        foregroundTerminalIds,
      }),
    [
      workspaces,
      activeWorkspaceId,
      focusedPaneIndex,
      docks,
      focusedDock,
      focusedDockPaneId,
      persistHiddenDocks,
      evictedPaneIds,
      requestedPaneIds,
      foregroundTerminalIds,
    ],
  );

  // Grant before paint so users see one real terminal plus placeholders, never
  // an intermediate frame containing placeholders for every terminal.
  useLayoutEffect(() => {
    syncCandidates(candidates);
  }, [candidates, syncCandidates]);

  // A renderer/backend defect must not leave every later pane blocked forever.
  // The timeout is only a liveness fallback; normal advancement is explicit.
  useEffect(() => {
    if (!activePaneId) return;
    const timeout = window.setTimeout(() => {
      const state = useTerminalStartupStore.getState();
      if (state.activePaneId !== activePaneId) return;
      console.warn(
        `[terminal-startup] ${activePaneId} did not become ready within ${TERMINAL_STARTUP_SLOT_TIMEOUT_MS}ms; advancing the queue`,
      );
      state.settleStartup(activePaneId);
    }, TERMINAL_STARTUP_SLOT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [activePaneId]);
}
