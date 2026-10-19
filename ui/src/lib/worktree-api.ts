import { invoke } from "@tauri-apps/api/core";

export interface WorktreeUsage {
  terminalId: string | null;
  paneId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  cwd: string;
  kind: "live" | "saved" | "daemon";
  agentType: string | null;
}
export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  isMain: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
  usage: WorktreeUsage[];
}
export interface WorktreeSnapshot {
  /** Backend-resolved host path, including the WSL distribution when relevant. */
  workingDir: string;
  repositoryPath: string;
  commonDir: string;
  worktrees: WorktreeEntry[];
  usageWarnings?: string[];
}
export interface WorktreeInspection {
  worktree: Omit<WorktreeEntry, "usage">;
  trackedChanges: number;
  untrackedFiles: number;
  ignoredFiles: number;
  files: { kind: "tracked" | "untracked" | "ignored"; path: string }[];
  filesTruncated: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  blockers: string[];
  canRemove: boolean;
  usage: WorktreeUsage[];
  usageWarnings?: string[];
}
export function getWorktreeSnapshot(
  workingDir: string,
  sourceTerminalId?: string,
): Promise<WorktreeSnapshot> {
  return invoke("get_worktree_snapshot", { workingDir, sourceTerminalId });
}
export function inspectWorktree(workingDir: string, path: string): Promise<WorktreeInspection> {
  return invoke("inspect_worktree", { workingDir, path });
}
export function removeWorktree(
  workingDir: string,
  path: string,
  expectedHead: string,
): Promise<void> {
  return invoke("remove_worktree", { workingDir, path, expectedHead });
}
