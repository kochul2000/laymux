/** Escape a string for safe use as a single-quoted shell argument. */
export function shellEscape(s: string): string {
  // Wrap in single quotes; escape embedded single quotes as '\''
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Join a base path and a child name, handling both / and \ separators. */
export function joinPath(base: string, child: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + child : base + sep + child;
}

/** Get the parent directory of a path. Returns "" if already at root. */
export function parentPath(path: string): string {
  if (!path) return "";
  const sep = path.includes("\\") ? "\\" : "/";
  // Remove trailing separator
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const lastSep = trimmed.lastIndexOf(sep);
  if (lastSep <= 0) return sep; // root
  return trimmed.slice(0, lastSep);
}

/**
 * Normalize a path typed or pasted into the File Explorer address bar.
 *
 * - trims surrounding whitespace,
 * - strips one layer of wrapping quotes (drag-and-drop / shell copy often yields
 *   quoted paths — same convenience as the file viewer's {@link normalizeViewerPath}),
 * - removes a single trailing separator while preserving roots ("/" and "C:\\").
 *
 * Returns "" for blank input so callers can treat it as "do nothing".
 */
export function normalizeAddressInput(raw: string): string {
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
  if (p.length === 0) return "";

  // Drop a single trailing separator unless the result would be a root.
  const sep = p.includes("\\") ? "\\" : "/";
  if (p.endsWith(sep) && p.length > 1) {
    const trimmed = p.slice(0, -1);
    // Keep windows drive roots like "C:\" intact (trimming would give "C:").
    const isDriveRoot = /^[A-Za-z]:$/.test(trimmed);
    if (!isDriveRoot) p = trimmed;
  }
  return p;
}

/** Filesystem facts about an address-bar path, resolved by the Rust backend. */
export interface AddressPathInfo {
  exists: boolean;
  isDirectory: boolean;
}

/** Decision for what an address-bar submission should do. */
export type AddressNavigation =
  | { kind: "invalid" }
  | { kind: "navigate"; dir: string }
  | { kind: "open-file"; dir: string; file: string };

/**
 * Decide what to do when the user submits a path in the address bar.
 *
 * - empty / non-existent → `invalid` (caller shows feedback, does not navigate),
 * - directory → `navigate` to it,
 * - file → `open-file`: navigate to the file's parent directory AND open the file
 *   in the shared viewer (issue #278 convenience).
 *
 * Pure: filesystem facts are supplied via {@link AddressPathInfo} so this can be
 * unit-tested without touching the backend.
 */
export function resolveAddressNavigation(raw: string, info: AddressPathInfo): AddressNavigation {
  const path = normalizeAddressInput(raw);
  if (!path || !info.exists) return { kind: "invalid" };
  if (info.isDirectory) return { kind: "navigate", dir: path };
  return { kind: "open-file", dir: parentPath(path), file: path };
}
