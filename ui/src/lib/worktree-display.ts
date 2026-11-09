import type { WorktreeEntry, WorktreeInspection } from "./worktree-api";
import {
  formatWorktreeBlockerLabel,
  worktreeMessage,
  type WorktreeMessage,
} from "./worktree-presentation";

/** Canonical POSIX/WSL names can contain literal backslashes. */
export function worktreeFolderName(path: string): string {
  const normalized = path.startsWith("/") ? path : path.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "").split("/").pop() || path;
}

export function worktreeRowStatus(
  entry: WorktreeEntry,
  value?: WorktreeInspection,
  includeTerminalCount = true,
  message: WorktreeMessage = worktreeMessage,
): string {
  if (!value) return message("검사 중…");
  if (value.canRemove) return message("정리 후보");
  const parts: string[] = [];
  const counts: string[] = [];
  if (value.trackedChanges) counts.push(message("변경 {0}", [value.trackedChanges]));
  if (value.untrackedFiles) counts.push(message("미추적 {0}", [value.untrackedFiles]));
  if (value.ignoredFiles) counts.push(message("무시 {0}", [value.ignoredFiles]));
  if (includeTerminalCount && value.usage.length)
    counts.unshift(message("터미널 {0}개", [value.usage.length]));
  for (const blocker of value.blockers) {
    if (
      (blocker === "tracked_changes" && value.trackedChanges) ||
      (blocker === "untracked_files" && value.untrackedFiles) ||
      (blocker === "ignored_files" && value.ignoredFiles) ||
      (blocker === "in_use" && value.usage.length)
    )
      continue;
    if (blocker === "main" && entry.isMain) continue;
    parts.push(formatWorktreeBlockerLabel(blocker, message));
  }
  return (
    [...parts, ...counts].reduce(
      (joined, part) => (joined ? message("{0} · {1}", [joined, part]) : part),
      "",
    ) ||
    message(
      entry.isMain ? "기본 워크트리" : value.usage.length ? "변경 없음" : "보존 상태 확인 필요",
    )
  );
}
