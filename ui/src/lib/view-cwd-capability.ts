import type { ViewType } from "@/stores/types";

/**
 * Which half of the sync-group CWD contract a view participates in.
 *
 * Sending and receiving used to be one predicate because every CWD-aware view
 * did both. `GitHubView` only *follows* a CWD — it has no cursor to move and
 * nothing to propagate — so the two capabilities are now asked separately and
 * the control bar offers a view exactly the toggles it can honour.
 */
export function supportsCwdSend(type: ViewType | undefined): boolean {
  return type === "TerminalView" || type === "FileExplorerView";
}

export function supportsCwdReceive(type: ViewType | undefined): boolean {
  return supportsCwdSend(type) || type === "GitHubView";
}
