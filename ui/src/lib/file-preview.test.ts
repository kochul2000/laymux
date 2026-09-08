import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  documentPreviewKind,
  htmlToSafePreviewDocument,
  markdownToSafeHtml,
  sanitizePreviewHtml,
} from "./file-preview";

describe("빈 HTML 미리보기", () => {
  it.each([
    '<html><head><title>Report</title><script src="app.js"></script></head><body><div id="printer-container"></div><script>mountPrinter()</script></body></html>',
    '<div id="root"><!-- mount here --><span> \n </span></div>',
    "<canvas></canvas><script>draw()</script>",
    '<div id="root" style="width:100%;height:100vh;padding:20px"></div>',
    '<div style="display:none">App content</div>',
    '<div style="content-visibility:hidden">App content</div>',
    '<div style="opacity:0"><img src="data:image/png;base64,abc">App content</div>',
    '<div style="visibility:hidden"><span>App content</span></div>',
    '<div style="font-size:0"><span>App content</span></div>',
    '<div style="background:transparent;border:0 solid #ff0000"></div>',
    "",
  ])("표시할 본문이 없으면 PC 프로그램으로 열도록 안내한다", (html) => {
    const preview = htmlToSafePreviewDocument(html);
    expect(preview).toContain("PC의 브라우저 등 외부 프로그램으로 열어 주세요.");
    expect(preview).not.toContain("<script");
    expect(preview).toContain("script-src 'none'");
  });

  it.each([
    "<h1>Report</h1><script>enhance()</script>",
    '<img src="data:image/png;base64,abc">',
    '<input type="checkbox" checked>',
    "<hr>",
    '<div style="width:100px;height:100px;background:#ff0000"></div>',
    '<div style="content-visibility:hidden;width:80px;height:80px;background:#ff0000"></div>',
    '<div style="width:100px;height:100px;border:1px solid #ff0000"></div>',
    '<div style="visibility:hidden"><span style="visibility:visible">Report</span></div>',
    '<div style="font-size:0"><span style="font-size:14px">Report</span></div>',
    '<div style="display:none">hidden</div><p>Loading...</p>',
    "<pre></pre>",
    "<details><p>Report</p></details>",
  ])("정적 본문이나 시각 요소가 남아 있으면 유지한다", (html) => {
    expect(htmlToSafePreviewDocument(html)).not.toContain("PC의 브라우저");
  });

  it("Markdown의 빈 문서에는 HTML 안내를 넣지 않는다", () => {
    expect(buildPreviewDocument("", "markdown")).not.toContain("PC의 브라우저");
  });
});

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

  it("uses the same slim overlay scrollbar as the rest of laymux", () => {
    const doc = buildPreviewDocument("<div>Long preview</div>");

    expect(doc).toContain("::-webkit-scrollbar{width:20px;height:20px;}");
    expect(doc).toContain("background:#ffffff33");
    expect(doc).toContain("background:#ffffff59");
    expect(doc).toContain("border:6px solid transparent");
  });

  it("wraps markdown in the GitHub markdown container and embeds its stylesheet", () => {
    const doc = buildPreviewDocument("<h1>GitHub style</h1>", "markdown");

    expect(doc).toContain('<article class="markdown-body">');
    expect(doc).toContain(".markdown-body");
    expect(doc).not.toContain("color-mix(");
  });

  it("bakes the viewer's font into the document — the iframe never inherits the host's", () => {
    const doc = buildPreviewDocument("<h1>Safe</h1>", "html", {
      family: "Fira Code",
      size: 18,
    });

    expect(doc).toContain("font-size:18px !important");
    expect(doc).toContain('font-family:"Fira Code" !important');
  });

  it("escapes a font family that tries to close the style tag early", () => {
    const doc = buildPreviewDocument("<h1>Safe</h1>", "html", {
      family: 'evil";}</style><script>x',
      size: 13,
    });

    expect(doc).not.toContain("</style><script>");
    // `<`/`>` survive only as CSS hex escapes, never as literal HTML-breaking characters.
    expect(doc).toContain("\\3c /style\\3e \\3c script\\3e x");
  });
});
