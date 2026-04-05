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

describe("CSS design tokens — hover overlay", () => {
  const hoverTokens = [
    "--hover-bg",
    "--hover-bg-strong",
    "--active-bg",
    "--backdrop-light",
    "--backdrop-heavy",
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
  const utilityTokens = ["--separator-bg", "--transition-fast"];

  it.each(utilityTokens)("defines %s in :root", (token) => {
    const regex = new RegExp(`${token.replace(/[-/]/g, "\\$&")}\\s*:`);
    expect(cssContent).toMatch(regex);
  });
});
