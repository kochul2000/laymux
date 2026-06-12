import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

/**
 * CSS Design Token existence tests — Phase 0 of UI refactoring (#126).
 * Ensures all required tokens are defined in index.css :root block.
 */

let cssContent: string;

beforeAll(() => {
  cssContent = fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf-8");
});

describe("CSS design tokens — accent opacity variants", () => {
  const accentTokens = [
    "--accent-50",
    "--accent-20",
    "--accent-12",
    "--accent-10",
    "--accent-08",
    "--accent-06",
    "--orange-15",
  ];

  it.each(accentTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS design tokens — hover overlay", () => {
  const hoverTokens = [
    "--hover-bg",
    "--hover-bg-strong",
    "--hover-bg-subtle",
    "--active-bg",
    "--backdrop-light",
    "--backdrop-heavy",
    "--bar-bg-hover",
    "--bar-bg-overlay",
  ];

  it.each(hoverTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS design tokens — dimensions", () => {
  const dimensionTokens = ["--bar-h", "--btn-h", "--btn-min-w"];

  it.each(dimensionTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS design tokens — border-radius", () => {
  const radiusTokens = ["--radius-sm", "--radius-md", "--radius-lg"];

  it.each(radiusTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS design tokens — font-size", () => {
  const fontTokens = ["--fs-2xs", "--fs-xs", "--fs-sm", "--fs-md", "--fs-lg"];

  it.each(fontTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS design tokens — utility", () => {
  const utilityTokens = [
    "--separator-bg",
    "--transition-fast",
    "--terminal-composition-underline-color",
  ];

  it.each(utilityTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});

describe("CSS utility classes — hover", () => {
  it("defines .hover-bg:hover class", () => {
    expect(cssContent).toMatch(/\.hover-bg:hover\s*\{/);
  });

  it("defines .hover-bg-strong:hover class", () => {
    expect(cssContent).toMatch(/\.hover-bg-strong:hover\s*\{/);
  });

  it("defines .hover-bg-danger:hover class", () => {
    expect(cssContent).toMatch(/\.hover-bg-danger:hover\s*\{/);
  });
});

describe("CSS utility classes — separator", () => {
  it("defines .ui-sep class", () => {
    expect(cssContent).toMatch(/\.ui-sep\s*\{/);
  });
});

describe("CSS utility classes — toolbar", () => {
  it("defines .ui-toolbar class", () => {
    expect(cssContent).toMatch(/\.ui-toolbar\s*\{/);
  });
});

describe("CSS utility classes — focus", () => {
  it("defines .ui-focus-ring:focus-visible class", () => {
    expect(cssContent).toMatch(/\.ui-focus-ring:focus-visible\s*\{/);
  });
});

describe("CSS utility classes — terminal IME composition", () => {
  it("underlines the active composition preview", () => {
    expect(cssContent).toMatch(
      /\.terminal-composition-preview\s*\{[^}]*text-decoration-line:\s*underline;/s,
    );
    expect(cssContent).toMatch(
      /\.terminal-composition-preview\s*\{[^}]*text-decoration-color:\s*var\(--terminal-composition-underline-color\);/s,
    );
    expect(cssContent).toMatch(
      /\.terminal-composition-preview\s*\{[^}]*text-decoration-thickness:\s*1px;/s,
    );
    expect(cssContent).toMatch(
      /\.terminal-composition-preview\s*\{[^}]*text-underline-offset:\s*2px;/s,
    );
  });
});

describe("CSS design tokens — control bar overlay opacity (issue #320)", () => {
  it("--bar-bg-overlay is semi-transparent (alpha <= 0.75) so content beneath stays visible", () => {
    const match = cssContent.match(
      /--bar-bg-overlay\s*:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeLessThanOrEqual(0.75);
  });
});

describe("CSS design tokens — key value validation", () => {
  const keyValues: [string, string][] = [
    ["--bar-h", "28px"],
    ["--btn-h", "22px"],
    ["--btn-min-w", "22px"],
    ["--radius-sm", "2px"],
    ["--radius-md", "3px"],
    ["--radius-lg", "6px"],
  ];

  it.each(keyValues)("%s equals %s", (token, value) => {
    const escaped = token.replace(/[-/]/g, "\\$&");
    const regex = new RegExp(`${escaped}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    expect(cssContent).toMatch(regex);
  });
});
