export { filePreviewKind } from "./file-viewer";
export type { FilePreviewKind } from "./file-viewer";

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
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align"]),
  input: new Set(["type", "checked", "disabled"]),
};

export function htmlToSafePreviewDocument(html: string): string {
  return buildPreviewDocument(sanitizePreviewHtml(html));
}

export function markdownToSafePreviewDocument(markdown: string): string {
  return buildPreviewDocument(markdownToSafeHtml(markdown));
}

export function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const language = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : "";
      out.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, rows));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*[-*+]\s+/, "");
        items.push(renderListItem(text));
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderParagraph(parts)}</blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^(#{1,6})\s+/) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(renderParagraph(paragraph));
  }

  return sanitizePreviewHtml(out.join("\n"));
}

export function sanitizePreviewHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  cleanChildren(doc.body);
  return doc.body.innerHTML;
}

export function buildPreviewDocument(safeHtml: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; frame-src 'none';\">",
    "<style>",
    "html,body{margin:0;min-height:100%;background:#181825;color:#cdd6f4;font:13px/1.55 Consolas,'Fira Code',monospace;}",
    "body{box-sizing:border-box;padding:16px;overflow-wrap:anywhere;}",
    "a{color:#89b4fa;text-decoration:none;}a:hover{text-decoration:underline;}",
    "pre{overflow:auto;padding:10px;border:1px solid #313244;border-radius:6px;background:#11111b;}",
    "code{font-family:Consolas,'Fira Code',monospace;background:#11111b;border-radius:3px;padding:1px 3px;}",
    "pre code{background:transparent;padding:0;}",
    "blockquote{margin:0 0 12px;padding-left:12px;border-left:3px solid #45475a;color:#a6adc8;}",
    "table{border-collapse:collapse;max-width:100%;margin:10px 0;}th,td{border:1px solid #45475a;padding:4px 8px;}th{background:#313244;}",
    "img{max-width:100%;height:auto;}hr{border:0;border-top:1px solid #313244;}input[type=checkbox]{vertical-align:middle;}",
    "</style>",
    "</head><body>",
    safeHtml,
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

function renderParagraph(lines: string[]): string {
  return `<p>${renderInline(lines.join(" "))}</p>`;
}

function renderListItem(text: string): string {
  const task = text.match(/^\[(x|X| )]\s+(.+)$/);
  if (!task) return `<li>${renderInline(text)}</li>`;

  const checked = task[1].toLowerCase() === "x" ? " checked" : "";
  return `<li><input type="checkbox"${checked} disabled> ${renderInline(task[2])}</li>`;
}

function renderTable(header: string[], rows: string[][]): string {
  const head = header.map((cell) => `<th>${renderInline(cell.trim())}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell.trim())}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderInline(text: string): string {
  const code: string[] = [];
  let rendered = escapeHtml(text).replace(/`([^`]+)`/g, (_, value: string) => {
    const token = `\u0000CODE${code.length}\u0000`;
    code.push(`<code>${value}</code>`);
    return token;
  });

  rendered = rendered.replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
  });
  rendered = rendered.replace(/\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    return `<a href="${escapeAttr(href)}">${label}</a>`;
  });
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  code.forEach((value, index) => {
    rendered = rendered.replace(`\u0000CODE${index}\u0000`, value);
  });

  return rendered;
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index]) && index + 1 < lines.length && isTableSeparator(lines[index + 1]);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
