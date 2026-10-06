import type { ViewType } from "@/stores/types";

/**
 * Short human labels for view types, shared by the pane control bar label and
 * the pane stack tabs (ADR-0295) so the two never name the same view
 * differently.
 */
export const VIEW_LABELS: Record<ViewType, string> = {
  WorkspaceSelectorView: "Workspaces",
  SettingsView: "Settings",
  TerminalView: "Terminal",
  IssueReporterView: "Issue Reporter",
  MemoView: "Memo",
  UsageView: "Claude Usage",
  CodexUsageView: "Codex Usage",
  GrokUsageView: "Grok Usage",
  FileExplorerView: "File Explorer",
  GitHubView: "GitHub",
  EmptyView: "Empty",
};

/** Label for a view type, falling back to the raw type for unknown values. */
export function viewLabel(viewType: ViewType | string): string {
  return VIEW_LABELS[viewType as ViewType] ?? viewType;
}
