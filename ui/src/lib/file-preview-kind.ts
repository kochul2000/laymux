import { fileExtension } from "./file-viewer";
import { documentPreviewKind, type DocumentPreviewKind } from "./file-preview";
import { previewLanguage } from "./preview/code-highlight";

/**
 * How the desktop file viewer renders one text file (ADR-0109).
 *
 * Two families sit behind this union and the difference is a trust boundary,
 * not a styling choice:
 *
 * - `html` / `markdown` are **documents**. Their content is parsed as HTML,
 *   sanitized, and shown inside a sandboxed iframe under a restricted CSP.
 * - everything else is **structured data**. A pure parser turns the text into
 *   values and React renders those values. No HTML string is ever built, which
 *   is why no sanitizer is involved.
 *
 * Adding a kind means picking a family, and the family decides the renderer.
 */
export type FilePreviewKind =
  | DocumentPreviewKind
  | "json"
  | "jsonl"
  | "diff"
  | "csv"
  | "log"
  | "code";

/** Kinds whose renderer is the sandboxed iframe rather than React DOM. */
export function isDocumentPreviewKind(kind: FilePreviewKind): kind is DocumentPreviewKind {
  return kind === "html" || kind === "markdown";
}

const JSON_EXTENSIONS = new Set([".json", ".jsonc", ".json5"]);
const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const DIFF_EXTENSIONS = new Set([".diff", ".patch"]);
const DELIMITED_EXTENSIONS = new Set([".csv", ".tsv", ".tab"]);
const LOG_EXTENSIONS = new Set([".log"]);

/**
 * Pick the renderer for a path, or `null` to show the file as plain source.
 *
 * The decision is made from the extension alone. Sniffing the content would
 * rescue mislabeled files, but its mistakes are silent — a log that happens to
 * start with `{` would be drawn as a JSON tree with no way for the reader to
 * tell the viewer got it wrong. An extension is predictable and the user can
 * correct it by renaming.
 */
export function filePreviewKind(path: string): FilePreviewKind | null {
  const documentKind = documentPreviewKind(path);
  if (documentKind) return documentKind;

  const ext = fileExtension(path);
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (JSONL_EXTENSIONS.has(ext)) return "jsonl";
  if (DIFF_EXTENSIONS.has(ext)) return "diff";
  if (DELIMITED_EXTENSIONS.has(ext)) return "csv";
  if (LOG_EXTENSIONS.has(ext)) return "log";
  // Syntax highlighting is last: it only claims a file when a grammar exists,
  // so an unknown extension still falls through to plain source.
  if (previewLanguage(path)) return "code";
  return null;
}

/** Whether `.svg` should offer the image/source toggle instead of a bare image. */
export function isSvgPath(path: string): boolean {
  return fileExtension(path) === ".svg";
}
