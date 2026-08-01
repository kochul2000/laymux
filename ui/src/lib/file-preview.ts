import githubMarkdownCss from "github-markdown-css/github-markdown.css?raw";
import { Marked } from "marked";
import { fileExtension } from "./file-viewer";

/**
 * The document family of file previews (ADR-0109): file types whose content is
 * a document and must therefore be parsed as HTML, sanitized, and shown behind
 * a restricted CSP inside a sandboxed iframe.
 *
 * Everything else the viewer renders — JSON, CSV, diffs, logs, source code —
 * belongs to the structured family in `file-preview-kind.ts`, is turned into
 * plain values by a pure parser, and is rendered as React DOM. That family must
 * never reach the functions in this module: they exist to build HTML, and
 * sending non-document content through them would create an HTML string where
 * the design says there is none.
 */
export type DocumentPreviewKind = "html" | "markdown";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
]);

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const GLOBAL_ATTRIBUTES = new Set(["class", "id", "title", "style"]);

const TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  details: new Set(["open"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  ol: new Set(["start"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align"]),
  input: new Set(["type", "checked", "disabled"]),
};

const markdownRenderer = new Marked();

const HTML_PREVIEW_CSS = [
  "html,body{margin:0;min-height:100%;background:#181825;color:#cdd6f4;font:13px/1.55 Consolas,'Fira Code',monospace;}",
  "body{box-sizing:border-box;padding:16px;overflow-wrap:anywhere;}",
  "a{color:#89b4fa;text-decoration:none;}a:hover{text-decoration:underline;}",
  "pre{overflow:auto;padding:10px;border:1px solid #313244;border-radius:6px;background:#11111b;}",
  "code{font-family:Consolas,'Fira Code',monospace;background:#11111b;border-radius:3px;padding:1px 3px;}",
  "pre code{background:transparent;padding:0;}",
  "blockquote{margin:0 0 12px;padding-left:12px;border-left:3px solid #45475a;color:#a6adc8;}",
  "table{border-collapse:collapse;max-width:100%;margin:10px 0;}th,td{border:1px solid #45475a;padding:4px 8px;}th{background:#313244;}",
  "img{max-width:100%;height:auto;}hr{border:0;border-top:1px solid #313244;}input[type=checkbox]{vertical-align:middle;}",
].join("");

const MARKDOWN_PREVIEW_LAYOUT_CSS = [
  "html,body{margin:0;min-height:100%;}",
  ".markdown-body{box-sizing:border-box;min-width:0;max-width:980px;min-height:100vh;margin:0 auto;padding:45px;}",
  "@media(max-width:767px){.markdown-body{padding:15px;}}",
].join("");

export function documentPreviewKind(path: string): DocumentPreviewKind | null {
  const ext = fileExtension(path);
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  return null;
}

export function htmlToSafePreviewDocument(html: string): string {
  return buildPreviewDocument(sanitizePreviewHtml(html));
}

export function markdownToSafePreviewDocument(markdown: string): string {
  return buildPreviewDocument(markdownToSafeHtml(markdown), "markdown");
}

export function markdownToSafeHtml(markdown: string): string {
  return sanitizePreviewHtml(
    markdownRenderer.parse(markdown, {
      async: false,
      breaks: false,
      gfm: true,
    }),
  );
}

export function sanitizePreviewHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  cleanChildren(doc.body);
  return doc.body.innerHTML;
}

export function buildPreviewDocument(
  safeHtml: string,
  previewKind: DocumentPreviewKind = "html",
): string {
  // Switch rather than a boolean so a future document kind has to state its own
  // stylesheet instead of silently inheriting the raw-HTML one.
  let stylesheet: string;
  let body: string;
  switch (previewKind) {
    case "markdown":
      stylesheet = `${githubMarkdownCss}\n${MARKDOWN_PREVIEW_LAYOUT_CSS}`;
      body = `<article class="markdown-body">${safeHtml}</article>`;
      break;
    case "html":
      stylesheet = HTML_PREVIEW_CSS;
      body = safeHtml;
      break;
  }

  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; frame-src 'none';\">",
    "<style>",
    stylesheet,
    "</style>",
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

function cleanChildren(parent: Node): void {
  for (const child of Array.from(parent.childNodes)) {
    if (!(child instanceof Element)) continue;

    const tag = child.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      child.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      cleanChildren(child);
      unwrapElement(child);
      continue;
    }

    sanitizeAttributes(child, tag);
    cleanChildren(child);
  }
}

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  element.remove();
}

function sanitizeAttributes(element: Element, tag: string): void {
  const allowed = TAG_ATTRIBUTES[tag] ?? new Set<string>();

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    if (name.startsWith("on") || name === "srcdoc") {
      element.removeAttribute(attr.name);
      continue;
    }

    const isAria = name.startsWith("aria-");
    const isData = name.startsWith("data-");
    const isAllowed = GLOBAL_ATTRIBUTES.has(name) || allowed.has(name) || isAria || isData;
    if (!isAllowed) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (name === "href" && !isSafeLinkUrl(value)) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (name === "src" && !isSafeImageUrl(value)) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (name === "style" && !isSafeInlineStyle(value)) {
      element.removeAttribute(attr.name);
      continue;
    }
  }

  if (tag === "a" && element.hasAttribute("href")) {
    element.setAttribute("rel", "noreferrer");
  }

  if (tag === "input") {
    const input = element as HTMLInputElement;
    if (input.getAttribute("type")?.toLowerCase() !== "checkbox") {
      element.remove();
      return;
    }
    input.setAttribute("disabled", "");
  }
}

function isSafeLinkUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("#") ||
    /^https?:\/\//i.test(trimmed) ||
    /^mailto:/i.test(trimmed) ||
    /^tel:/i.test(trimmed)
  );
}

function isSafeImageUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|avif);base64,/i.test(value.trim());
}

function isSafeInlineStyle(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    !lower.includes("url(") &&
    !lower.includes("@import") &&
    !lower.includes("expression(") &&
    !lower.includes("behavior:") &&
    !lower.includes("-moz-binding") &&
    !lower.includes("javascript:")
  );
}
