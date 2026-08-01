import type { GithubRepoStatus } from "@/lib/tauri-api";

/**
 * Why the list is not showing issues. `null` means the snapshot is usable —
 * an empty list then means the repository really has nothing open.
 */
export function statusMessage(status: GithubRepoStatus): string | null {
  switch (status.type) {
    case "ready":
      return null;
    case "notAGithubRepo":
      return "No GitHub repository for this pane's CWD";
    case "ghMissing":
      return "`gh` not found on PATH";
    case "unauthorized":
      return "Run `gh auth login` to read issues and PRs";
    case "failed":
      return status.message;
  }
}

/** Compact "updated" stamp; the list is a watch surface, not an audit log. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
