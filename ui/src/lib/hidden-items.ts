import { computePaneNumbers } from "@/lib/pane-numbers";
import type { Workspace, WorkspacePane } from "@/stores/types";

export interface HiddenPaneItem {
  workspace: Workspace;
  pane: WorkspacePane;
  /** Index in the original WorkspacePane[] layout, used for focus. */
  paneIndex: number;
  /** Stable display number derived from layout geometry. */
  paneNumber: number;
}

export interface HiddenWorkspaceItem {
  workspace: Workspace;
  /** Individually-hidden pane flags retained below this hidden workspace. */
  hiddenPanes: HiddenPaneItem[];
}

export interface DeriveHiddenItemsInput {
  /** Workspaces in the order currently rendered by the selector. */
  workspaces: Workspace[];
  hiddenWorkspaceIds: Set<string>;
  hiddenPaneIds: Set<string>;
}

export interface DerivedHiddenItems {
  visibleWorkspaces: Workspace[];
  hiddenWorkspaces: HiddenWorkspaceItem[];
  /** Hidden panes whose parent workspace is visible. */
  hiddenPanes: HiddenPaneItem[];
  validHiddenWorkspaceIds: Set<string>;
  validHiddenPaneIds: Set<string>;
  staleWorkspaceIds: Set<string>;
  stalePaneIds: Set<string>;
  /** Valid raw hidden ID count, including pane flags below hidden workspaces. */
  count: number;
}

/**
 * Derive every hidden-items display model from the two independent raw sets.
 * Keeping this in one pure function prevents the selector, shelf and count chip
 * from drifting apart when workspaces/panes are removed or nested flags overlap.
 */
export function deriveHiddenItems(input: DeriveHiddenItemsInput): DerivedHiddenItems {
  const { workspaces, hiddenWorkspaceIds, hiddenPaneIds } = input;
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const paneItemsById = new Map<string, HiddenPaneItem>();

  for (const workspace of workspaces) {
    const paneNumbers = computePaneNumbers(workspace.panes);
    workspace.panes.forEach((pane, paneIndex) => {
      paneItemsById.set(pane.id, {
        workspace,
        pane,
        paneIndex,
        paneNumber: paneNumbers.get(pane.id) ?? paneIndex + 1,
      });
    });
  }

  const validHiddenWorkspaceIds = new Set(
    [...hiddenWorkspaceIds].filter((id) => workspaceById.has(id)),
  );
  const validHiddenPaneIds = new Set([...hiddenPaneIds].filter((id) => paneItemsById.has(id)));
  const staleWorkspaceIds = new Set(
    [...hiddenWorkspaceIds].filter((id) => !validHiddenWorkspaceIds.has(id)),
  );
  const stalePaneIds = new Set([...hiddenPaneIds].filter((id) => !validHiddenPaneIds.has(id)));

  const visibleWorkspaces: Workspace[] = [];
  const hiddenWorkspaces: HiddenWorkspaceItem[] = [];
  const hiddenPanes: HiddenPaneItem[] = [];

  for (const workspace of workspaces) {
    const nestedHiddenPanes = workspace.panes
      .filter((pane) => validHiddenPaneIds.has(pane.id))
      .map((pane) => paneItemsById.get(pane.id))
      .filter((item): item is HiddenPaneItem => item !== undefined);

    if (validHiddenWorkspaceIds.has(workspace.id)) {
      hiddenWorkspaces.push({ workspace, hiddenPanes: nestedHiddenPanes });
      continue;
    }

    visibleWorkspaces.push(workspace);
    hiddenPanes.push(...nestedHiddenPanes);
  }

  return {
    visibleWorkspaces,
    hiddenWorkspaces,
    hiddenPanes,
    validHiddenWorkspaceIds,
    validHiddenPaneIds,
    staleWorkspaceIds,
    stalePaneIds,
    count: validHiddenWorkspaceIds.size + validHiddenPaneIds.size,
  };
}

export interface FindNextVisibleWorkspaceInput {
  /** Current selector order (manual or notification). */
  orderedWorkspaces: Workspace[];
  activeWorkspaceId: string;
  hiddenWorkspaceIds: Set<string>;
}

/**
 * Find the next visible workspace after the active one, wrapping once.
 * The active workspace itself is excluded because the caller is about to hide it.
 */
export function findNextVisibleWorkspaceId(input: FindNextVisibleWorkspaceInput): string | null {
  const { orderedWorkspaces, activeWorkspaceId, hiddenWorkspaceIds } = input;
  if (orderedWorkspaces.length <= 1) return null;
  const activeIndex = orderedWorkspaces.findIndex(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (activeIndex < 0) return null;

  for (let offset = 1; offset < orderedWorkspaces.length; offset += 1) {
    const workspace = orderedWorkspaces[(activeIndex + offset) % orderedWorkspaces.length];
    if (!hiddenWorkspaceIds.has(workspace.id)) return workspace.id;
  }
  return null;
}
