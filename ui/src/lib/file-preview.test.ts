import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  documentPreviewKind,
  markdownToSafeHtml,
  sanitizePreviewHtml,
} from "./file-preview";

describe("documentPreviewKind", () => {
  it("defaults html and markdown files to preview mode", () => {
    expect(documentPreviewKind("/tmp/report.HTML")).toBe("html");
    expect(documentPreviewKind("/tmp/readme.md")).toBe("markdown");
    expect(documentPreviewKind("/tmp/readme.markdown")).toBe("markdown");
  });

  it("returns null for regular text files", () => {
    expect(documentPreviewKind("/tmp/a.txt")).toBeNull();
  });

  it("claims none of the structured preview types", () => {
    // These render as React DOM, never as a sanitized HTML document. Remote
    // uses this classifier to decide what may become a `previewDocument`, so a
    // leak here would push structured content through the sanitizer.
    for (const path of ["/tmp/a.json", "/tmp/a.csv", "/tmp/a.diff", "/tmp/a.log", "/tmp/a.ts"]) {
      expect(documentPreviewKind(path)).toBeNull();
    }
  });
});

describe("markdownToSafeHtml", () => {
  it("renders GitHub-flavored markdown", () => {
    const html = markdownToSafeHtml(
      [
        "# Title",
        "",
        "- first",
        "- [x] done",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| A | B |",
        "",
        "[docs](https://example.com)",
        "",
        "~~removed~~",
        "",
        "https://example.org",
      ].join("\n"),
    );
    const rendered = new DOMParser().parseFromString(html, "text/html");
    const task = rendered.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>first</li>");
    expect(task?.checked).toBe(true);
    expect(task?.disabled).toBe(true);
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("const value = 1;");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<del>removed</del>");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain(">https://example.org</a>");
  });

  it("supports nested CommonMark blocks and sanitizes embedded HTML", () => {
    const html = markdownToSafeHtml(
      [
        "- parent",
        "  - child with **strong** text",
        "",
        '<details open onclick="alert(1)"><summary>More</summary><script>alert(2)</script>Safe</details>',
      ].join("\n"),
    );

    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain('<details open="">');
    expect(html).toContain("<summary>More</summary>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
  });
});

describe("sanitizePreviewHtml", () => {
  it("removes scripts, event handlers, forms, and dangerous urls", () => {
    const html = sanitizePreviewHtml(`
      <h1 onclick="alert(1)">Report</h1>
      <script>window.__ran = true</script>
      <form action="https://example.com"><input name="x"></form>
      <a href="javascript:alert(1)">bad</a>
      <img src="./secret.png" onerror="alert(1)">
      <img src="data:image/png;base64,abc">
    `);

    expect(html).toContain("<h1>Report</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("./secret.png");
    expect(html).toContain("data:image/png;base64,abc");
  });

  it("sanitizes children when unwrapping unknown elements", () => {
    const html = sanitizePreviewHtml(`
      <custom-card>
        <img src="./secret.png" onerror="alert(1)">
        <a href="javascript:alert(1)" onclick="alert(2)">bad</a>
      </custom-card>
    `);

    expect(html).not.toContain("secret.png");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).toContain("<a>bad</a>");
  });
});

describe("buildPreviewDocument", () => {
  it("wraps sanitized content with a restrictive CSP", () => {
    const doc = buildPreviewDocument("<h1>Safe</h1>");

    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<h1>Safe</h1>");
  });

  it("wraps markdown in the GitHub markdown container and embeds its stylesheet", () => {
    const doc = buildPreviewDocument("<h1>GitHub style</h1>", "markdown");

    expect(doc).toContain('<article class="markdown-body">');
    expect(doc).toContain(".markdown-body");
    expect(doc).not.toContain("color-mix(");
  });
});
