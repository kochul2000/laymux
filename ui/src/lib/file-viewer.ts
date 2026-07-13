import type { ExtensionViewer } from "@/lib/tauri-api";

/**
 * Pure logic shared by every file-viewer entry point (File Explorer, the global
 * "open anywhere" shortcut, and the MCP `open_file_viewer` tool). Keeping the
 * decision logic free of React/fs lets it be unit-tested in isolation and reused
 * without duplication (#277 / #279 unify on a single viewer mechanism).
 */

/** Resolved instruction for how a single file should be displayed. */
export type ViewerResolution = { viewerType: "web" } | { viewerType: "terminal"; command: string };

export type FilePreviewKind = "html" | "markdown";

const HTML_PREVIEW_EXTENSIONS = new Set([".html", ".htm"]);
const MARKDOWN_PREVIEW_EXTENSIONS = new Set([".md", ".markdown"]);

/**
 * Normalize a raw file path string for the viewer.
 * Trims surrounding whitespace and strips a single pair of wrapping quotes
 * (drag-and-drop / shell copy often yields quoted paths). Returns "" when the
 * input is empty/blank — callers treat "" as "do not open".
 */
export function normalizeViewerPath(raw: string): string {
  if (typeof raw !== "string") return "";
  let p = raw.trim();
  if (p.length === 0) return "";
  // Strip one layer of matching wrapping quotes (single or double).
  if (
    (p.startsWith('"') && p.endsWith('"') && p.length >= 2) ||
    (p.startsWith("'") && p.endsWith("'") && p.length >= 2)
  ) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

/** Whether a normalized path is something the viewer can attempt to open. */
export function isOpenablePath(path: string): boolean {
  return normalizeViewerPath(path).length > 0;
}

/**
 * Build the terminal instance id for the global file viewer.
 *
 * The id doubles as the suffix of the backend↔frontend output channel
 * (`terminal-output-<id>`), and Tauri v2 only permits `[a-zA-Z0-9-/:_]` in
 * event names. A raw file path almost always contains a `.` (the extension) —
 * and may contain spaces or unicode — which makes the derived event name
 * invalid, so `listen()` throws and the viewer terminal never receives any PTY
 * output (the "opens to a black screen with a blinking cursor" bug: every
 * extension-mapped viewer like `.txt → vi` was affected). Replacing every
 * disallowed character keeps the id valid, and a short hash of the ORIGINAL
 * path is appended so two paths that sanitize to the same string (e.g.
 * `a/notes.txt` vs `a/notes_txt`) still get distinct ids — otherwise a path
 * change wouldn't tear down the previous viewer's PTY. The hash is hex, so it
 * stays within the allowed event-name character set.
 */
export function viewerInstanceId(path: string): string {
  const safe = path.replace(/[^a-zA-Z0-9/:_-]/g, "_");
  // FNV-1a 32-bit — deterministic, dependency-free, collision-resistant enough
  // to disambiguate the rare sanitization clash above.
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `global-file-viewer:${safe}:${(h >>> 0).toString(16)}`;
}

/** Extract the lowercased extension (with leading dot) from a path, or "". */
export function fileExtension(path: string): string {
  // Use the last path segment so directory dots don't count.
  const segment = path.split(/[\\/]/).pop() ?? "";
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext, or dotfile like ".bashrc"
  return segment.slice(dot).toLowerCase();
}

/** Return the built-in preview kind for paths that must stay in the web viewer. */
export function filePreviewKind(path: string): FilePreviewKind | null {
  const ext = fileExtension(path);
  if (HTML_PREVIEW_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_PREVIEW_EXTENSIONS.has(ext)) return "markdown";
  return null;
}

/** Resolve a terminal profile suited to the given path's filesystem.
 *  Unix paths get a WSL profile when the active profile isn't already WSL-like,
 *  mirroring File Explorer behaviour so external viewers resolve paths. */
export function resolveViewerProfile(
  path: string,
  profile: string,
  profiles: { name: string; commandLine?: string }[],
): string {
  const isUnixPath = path.startsWith("/");
  if (!isUnixPath) return profile;
  const current = profiles.find((p) => p.name === profile);
  if (current?.commandLine?.toLowerCase().includes("wsl")) return profile;
  const wsl = profiles.find((p) => p.commandLine?.toLowerCase().includes("wsl"));
  return wsl ? wsl.name : profile;
}

/**
 * Decide how to render a file: as a built-in web viewer (text/image/binary) or
 * via an external terminal command configured for its extension.
 *
 * Mirrors the historical File Explorer `openFile` branch so all entry points
 * stay consistent.
 */
export function resolveViewer(path: string, extensionViewers: ExtensionViewer[]): ViewerResolution {
  // HTML and Markdown have first-class preview/source modes. They must not be
  // intercepted by a legacy extension viewer mapping such as `.md -> vi`.
  if (filePreviewKind(path)) return { viewerType: "web" };

  const ext = fileExtension(path);
  if (ext) {
    const viewer = extensionViewers.find((v) => v.extensions.some((e) => e.toLowerCase() === ext));
    if (viewer && viewer.command.trim().length > 0) {
      return { viewerType: "terminal", command: viewer.command };
    }
  }
  return { viewerType: "web" };
}
