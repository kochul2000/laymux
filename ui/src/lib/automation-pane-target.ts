import { useWorkspaceStore } from "@/stores/workspace-store";
import type { Workspace, WorkspacePane } from "@/stores/types";

type PaneTarget =
  | { ws: Workspace; pane: WorkspacePane; paneIndex: number }
  | { err: { success: false; error: string } };

/** Resolve targets before mutation; explicit invalid targets never fall back to the UI. */
export function resolveAutomationPane(params: Record<string, unknown>): PaneTarget {
  const fail = (error: string): PaneTarget => ({ err: { success: false, error } });
  const state = useWorkspaceStore.getState();
  const { workspaceId, paneId, paneIndex } = params;
  if (workspaceId != null && (typeof workspaceId !== "string" || !workspaceId))
    return fail("workspaceId must be a non-empty string");
  if (paneId != null && (typeof paneId !== "string" || !paneId))
    return fail("paneId must be a non-empty string");
  if (paneIndex != null && (!Number.isSafeInteger(paneIndex) || (paneIndex as number) < 0))
    return fail("Pane index out of range: must be a non-negative integer");

  if (typeof paneId === "string") {
    // Slot ids take precedence over layer ids, matching workspace-store semantics.
    const ws =
      state.workspaces.find((w) => w.panes.some((p) => p.id === paneId)) ??
      state.workspaces.find((w) => w.panes.some((p) => p.layers.some((l) => l.id === paneId)));
    if (!ws) return fail(`Pane '${paneId}' not found`);
    const index = ws.panes.findIndex(
      (p) => p.id === paneId || p.layers.some((l) => l.id === paneId),
    );
    if (workspaceId != null && workspaceId !== ws.id)
      return fail("paneId and workspaceId refer to different workspaces");
    if (paneIndex != null && paneIndex !== index)
      return fail("paneId and paneIndex refer to different panes");
    return { ws, pane: ws.panes[index], paneIndex: index };
  }

  const ws = state.workspaces.find((w) => w.id === (workspaceId ?? state.activeWorkspaceId));
  if (!ws) return fail(`Workspace '${workspaceId ?? state.activeWorkspaceId}' not found`);
  if (paneIndex == null) return fail("paneId or paneIndex is required");
  const index = paneIndex as number;
  if (!ws.panes[index]) return fail(`Pane index out of range (0-${ws.panes.length - 1})`);
  return { ws, pane: ws.panes[index], paneIndex: index };
}
