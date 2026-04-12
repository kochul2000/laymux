import type { Workspace } from "@/stores/types";

export type WorkspaceSortOrder = "manual" | "notification";

interface NotificationLike {
  workspaceId: string;
  createdAt: number;
  readAt: number | null;
}

/**
 * Filter out hidden workspaces from a (pre-sorted) list.
 * Preserves the input order — apply after sortWorkspaces().
 */
export function filterVisibleWorkspaces(
  workspaces: Workspace[],
  hiddenIds: Set<string>,
): Workspace[] {
  if (hiddenIds.size === 0) return workspaces;
  return workspaces.filter((ws) => !hiddenIds.has(ws.id));
}

/**
 * Sort workspaces to match the visual display order.
 * - "manual": follows workspaceDisplayOrder (DnD), falls back to natural array order.
 * - "notification": unread-notification recency first, then original array order.
 */
export function sortWorkspaces(
  workspaces: Workspace[],
  sortOrder: WorkspaceSortOrder,
  displayOrder: string[],
  notifications: NotificationLike[],
): Workspace[] {
  if (sortOrder === "notification") {
    const originalIndex = new Map(workspaces.map((ws, i) => [ws.id, i]));
    const latestByWs = new Map<string, number>();
    for (const n of notifications) {
      if (n.readAt !== null) continue;
      const prev = latestByWs.get(n.workspaceId) ?? 0;
      if (n.createdAt > prev) latestByWs.set(n.workspaceId, n.createdAt);
    }
    return [...workspaces].sort((a, b) => {
      const diff = (latestByWs.get(b.id) ?? 0) - (latestByWs.get(a.id) ?? 0);
      if (diff !== 0) return diff;
      return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
    });
  }

  // Manual sort
  if (displayOrder.length === 0) return workspaces;
  const orderMap = new Map(displayOrder.map((id, i) => [id, i]));
  return [...workspaces].sort(
    (a, b) => (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity),
  );
}
