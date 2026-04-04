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
