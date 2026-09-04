/**
 * Shared File Explorer / File Viewer kind → Lucide name mapping.
 *
 * Desktop React mounts `FolderUpIcon`/`FolderIcon`/`LinkIcon`/`FileIcon`.
 * Remote `remote-icons.js` must keep the same names (ADR-0205 / ADR-0210).
 */

export type FileKindIconName = "FolderUp" | "Folder" | "Link" | "File";

export function fileKindIconName(
  entry: { isDirectory: boolean; isSymlink?: boolean },
  isParent = false,
): FileKindIconName {
  if (isParent) return "FolderUp";
  if (entry.isDirectory) return "Folder";
  if (entry.isSymlink) return "Link";
  return "File";
}
