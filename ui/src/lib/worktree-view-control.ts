export interface WorktreeViewAction {
  paneId: string;
  action: "refresh" | "select" | "filter";
  path?: string;
  filter?: "all" | "candidates";
}
export const WORKTREE_ACTION_EVENT = "laymux:worktree-action";
