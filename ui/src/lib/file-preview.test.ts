import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  filePreviewKind,
  markdownToSafeHtml,
  sanitizePreviewHtml,
} from "./file-preview";

describe("filePreviewKind", () => {
  it("defaults html and markdown files to preview mode", () => {
    expect(filePreviewKind("/tmp/report.HTML")).toBe("html");
    expect(filePreviewKind("/tmp/readme.md")).toBe("markdown");
    expect(filePreviewKind("/tmp/readme.markdown")).toBe("markdown");
  });

  it("returns null for regular text files", () => {
    expect(filePreviewKind("/tmp/a.txt")).toBeNull();
  });
});

describe("markdownToSafeHtml", () => {
  it("renders common markdown blocks", () => {
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
      ].join("\n"),
    );

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain('type="checkbox" checked="" disabled=""');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("const value = 1;");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com"');
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
});
