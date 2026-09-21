/**
 * Shared File Explorer / File Viewer kind → Lucide name mapping.
 *
 * Desktop React mounts `FolderUpIcon`/`FolderIcon`/`LinkIcon`/`FileIcon`.
 * Remote `remote-icons.js` imports this module (ADR-0205 / ADR-0210).
 */

export type FileKindIconName = "FolderUp" | "Folder" | "Link" | "File";

export const FILE_KIND_ICON_SIZE = 13;

export function fileKindColor(entry: { isDirectory: boolean; isSymlink?: boolean }): string {
  if (entry.isDirectory) return "var(--accent)";
  if (entry.isSymlink) return "var(--green)";
  return "var(--text-primary)";
}

export function fileKindIconName(
  entry: { isDirectory: boolean; isSymlink?: boolean },
  isParent = false,
): FileKindIconName {
  if (isParent) return "FolderUp";
  if (entry.isDirectory) return "Folder";
  if (entry.isSymlink) return "Link";
  return "File";
}
