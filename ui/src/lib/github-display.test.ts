import { describe, it, expect } from "vitest";
import {
  GITHUB_FONT_SIZE_DEFAULT,
  GITHUB_FONT_SIZE_MAX,
  GITHUB_FONT_SIZE_MIN,
  GITHUB_LABEL_MAX_WIDTH_MAX,
  GITHUB_LABEL_MAX_WIDTH_MIN,
  numberColorVar,
  readGithubFontSize,
  readGithubLabelMaxCount,
  readGithubLabelMaxWidth,
  rowFontFamily,
  secondaryFontSize,
} from "./github-display";

describe("github display settings", () => {
  it("clamps a hand-edited font size into the offered range", () => {
    expect(readGithubFontSize(13)).toBe(13);
    expect(readGithubFontSize(0)).toBe(GITHUB_FONT_SIZE_MIN);
    expect(readGithubFontSize(999)).toBe(GITHUB_FONT_SIZE_MAX);
    expect(readGithubFontSize(12.6)).toBe(13);
  });

  it("falls back to the pre-setting size for a missing or non-numeric value", () => {
    expect(readGithubFontSize(undefined)).toBe(GITHUB_FONT_SIZE_DEFAULT);
    expect(readGithubFontSize("11")).toBe(GITHUB_FONT_SIZE_DEFAULT);
    expect(readGithubFontSize(Number.NaN)).toBe(GITHUB_FONT_SIZE_DEFAULT);
  });

  it("keeps the secondary columns smaller than the title but never illegible", () => {
    expect(secondaryFontSize(11)).toBe(9);
    expect(secondaryFontSize(20)).toBe(18);
    // At the smallest row the 7px floor wins over "two smaller than the title",
    // so a hand-edited 1 cannot shrink the column past legibility.
    expect(secondaryFontSize(1)).toBe(7);
    expect(secondaryFontSize(GITHUB_FONT_SIZE_MIN)).toBe(7);
  });

  it("treats a zero label count as hiding the column", () => {
    expect(readGithubLabelMaxCount(0)).toBe(0);
    expect(readGithubLabelMaxCount(-3)).toBe(0);
    expect(readGithubLabelMaxCount(99)).toBe(5);
    expect(readGithubLabelMaxCount(undefined)).toBe(2);
  });

  it("clamps the label chip width", () => {
    expect(readGithubLabelMaxWidth(120)).toBe(120);
    expect(readGithubLabelMaxWidth(1)).toBe(GITHUB_LABEL_MAX_WIDTH_MIN);
    expect(readGithubLabelMaxWidth(10_000)).toBe(GITHUB_LABEL_MAX_WIDTH_MAX);
  });

  it("maps a color token to a theme variable and rejects anything else", () => {
    expect(numberColorVar("accent")).toBe("var(--accent)");
    expect(numberColorVar("muted")).toBe("var(--text-muted)");
    // A raw color from a hand-edited file must not reach the style attribute —
    // the token list is what keeps the row legible in every theme.
    expect(numberColorVar("#ff0000")).toBe("var(--yellow)");
    expect(numberColorVar(undefined)).toBe("var(--yellow)");
  });

  it("falls back to the UI font for a blank family", () => {
    expect(rowFontFamily("Fira Code")).toBe("Fira Code");
    expect(rowFontFamily("")).toBe("var(--ui-font)");
    expect(rowFontFamily("   ")).toBe("var(--ui-font)");
    expect(rowFontFamily(undefined)).toBe("var(--ui-font)");
  });
});
