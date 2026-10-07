import { viewLabel } from "@/lib/view-labels";
import { abbreviatePath, shortWorkspaceLabel } from "@/lib/workspace-summary";

export interface LayerTitleInput {
  viewType: string;
  /** Terminal OSC title, when the terminal is live. */
  title?: string;
  /** Terminal label (usually the profile name). */
  label?: string;
  profile?: string;
  cwd?: string;
}

/** Shells often report their directory (OSC 0/2 or a file:// URI) as the title. */
function isPathLikeTitle(title: string): boolean {
  return (
    /^file:\/\//i.test(title) ||
    /^[A-Za-z]:[\\/]/.test(title) ||
    title.startsWith("/") ||
    title.startsWith("~") ||
    title.startsWith("\\\\")
  );
}

/** Last path segment of a cwd, after the selector's own path normalisation. */
function lastSegment(cwd: string): string {
  const abbreviated = abbreviatePath(cwd);
  if (abbreviated === "~") return "~";
  const parts = abbreviated.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? abbreviated;
}

/**
 * Title of a pane stack tab (ADR-0297). A program-set terminal title wins
 * ("npm run dev", "✳ Claude Code"); a shell that only reports its path gets
 * the selector-style environment label plus the directory name ("PS ·
 * PycharmProjects"); other views use their view label.
 */
export function layerTabTitle(input: LayerTitleInput): string {
  if (input.viewType !== "TerminalView") return viewLabel(input.viewType);
  const title = input.title?.trim();
  if (title && !isPathLikeTitle(title)) return title;
  const env = shortWorkspaceLabel(input.profile || input.label || "Terminal");
  const cwd = input.cwd || (title && isPathLikeTitle(title) ? title : undefined);
  return cwd ? `${env} · ${lastSegment(cwd)}` : input.profile || input.label || "Terminal";
}
