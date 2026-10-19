import type { WorktreeEntry, WorktreeInspection } from "./worktree-api";
import { worktreeBlockerLabel } from "./worktree-presentation";

/** Canonical POSIX/WSL names can contain literal backslashes. */
export function worktreeFolderName(path: string): string {
  const normalized = path.startsWith("/") ? path : path.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "").split("/").pop() || path;
}

export function worktreeRowStatus(
  entry: WorktreeEntry,
  value?: WorktreeInspection,
  includeTerminalCount = true,
): string {
  if (!value) return "검사 중…";
  if (value.canRemove) return "정리 후보";
  const parts: string[] = [];
  const counts: string[] = [];
  if (value.trackedChanges) counts.push(`변경 ${value.trackedChanges}`);
  if (value.untrackedFiles) counts.push(`미추적 ${value.untrackedFiles}`);
  if (value.ignoredFiles) counts.push(`무시 ${value.ignoredFiles}`);
  if (includeTerminalCount && value.usage.length) counts.unshift(`터미널 ${value.usage.length}개`);
  for (const blocker of value.blockers) {
    if (
      (blocker === "tracked_changes" && value.trackedChanges) ||
      (blocker === "untracked_files" && value.untrackedFiles) ||
      (blocker === "ignored_files" && value.ignoredFiles) ||
      (blocker === "in_use" && value.usage.length)
    )
      continue;
    if (blocker === "main" && entry.isMain) continue;
    parts.push(worktreeBlockerLabel(blocker));
  }
  return (
    [...parts, ...counts].join(" · ") ||
    (entry.isMain ? "기본 워크트리" : value.usage.length ? "변경 없음" : "보존 상태 확인 필요")
  );
}
