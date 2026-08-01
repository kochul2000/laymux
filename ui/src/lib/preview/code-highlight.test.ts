import { describe, expect, it, vi } from "vitest";
import {
  MAX_HIGHLIGHT_BYTES,
  MAX_HIGHLIGHT_LINES,
  highlightCode,
  highlightSkipReason,
  previewLanguage,
  type HighlightLoader,
  type HighlightToken,
} from "./code-highlight";

/** Stand-in highlighter so the suite never pulls shiki (and its grammars) in. */
function fakeLoader(tokens: HighlightToken[][]) {
  const codeToTokens = vi.fn(() => ({ tokens }));
  const loader: HighlightLoader = vi.fn(async () => ({ codeToTokens }));
  return { loader, codeToTokens };
}

describe("previewLanguage", () => {
  it("maps known extensions to shiki grammar ids", () => {
    expect(previewLanguage("/src/app.ts")).toBe("typescript");
    expect(previewLanguage("/src/app.mts")).toBe("typescript");
    expect(previewLanguage("/src/app.tsx")).toBe("tsx");
    expect(previewLanguage("/src/app.mjs")).toBe("javascript");
    expect(previewLanguage("/src/main.rs")).toBe("rust");
    expect(previewLanguage("/src/main.py")).toBe("python");
    expect(previewLanguage("/src/Main.kt")).toBe("kotlin");
    expect(previewLanguage("/src/a.cxx")).toBe("cpp");
    expect(previewLanguage("/src/a.h")).toBe("c");
    expect(previewLanguage("/src/run.sh")).toBe("shellscript");
    expect(previewLanguage("/src/run.ps1")).toBe("powershell");
    expect(previewLanguage("/conf/app.yml")).toBe("yaml");
    expect(previewLanguage("/infra/main.tf")).toBe("terraform");
    expect(previewLanguage("/lib/mix.exs")).toBe("elixir");
    expect(previewLanguage("/plugin/init.vim")).toBe("viml");
    expect(previewLanguage("/scripts/task.nu")).toBe("nushell");
  });

  it("ignores extension case", () => {
    expect(previewLanguage("/src/App.TSX")).toBe("tsx");
    expect(previewLanguage("C:\\work\\NOTES.PY")).toBe("python");
  });

  it("returns null for dotfiles, extensionless paths, and unknown extensions", () => {
    expect(previewLanguage("/home/me/.bashrc")).toBeNull();
    expect(previewLanguage("/home/me/Makefile")).toBeNull();
    expect(previewLanguage("/home/me/notes.wat")).toBeNull();
    expect(previewLanguage("")).toBeNull();
  });
});

describe("highlightSkipReason", () => {
  it("allows content exactly at the byte and line limits", () => {
    expect(highlightSkipReason("a".repeat(MAX_HIGHLIGHT_BYTES))).toBeNull();
    expect(highlightSkipReason("\n".repeat(MAX_HIGHLIGHT_LINES - 1))).toBeNull();
  });

  it("reports too-large one byte past the limit", () => {
    expect(highlightSkipReason("a".repeat(MAX_HIGHLIGHT_BYTES + 1))).toBe("too-large");
  });

  it("reports too-many-lines one line past the limit", () => {
    expect(highlightSkipReason("\n".repeat(MAX_HIGHLIGHT_LINES))).toBe("too-many-lines");
  });

  it("measures UTF-8 bytes rather than string length", () => {
    // 100_001 three-byte characters: well under the limit in chars, over it in bytes.
    const multibyte = "가".repeat(100_001);

    expect(multibyte.length).toBeLessThan(MAX_HIGHLIGHT_BYTES);
    expect(highlightSkipReason(multibyte)).toBe("too-large");
  });
});

describe("highlightCode", () => {
  it("returns the loader's token lines verbatim", async () => {
    const tokens: HighlightToken[][] = [
      [
        { content: "const", color: "#cba6f7", fontStyle: "italic" },
        { content: " x", color: "#cdd6f4" },
      ],
    ];
    const { loader, codeToTokens } = fakeLoader(tokens);

    await expect(highlightCode("const x", "typescript", loader)).resolves.toBe(tokens);
    expect(loader).toHaveBeenCalledWith("typescript");
    expect(codeToTokens).toHaveBeenCalledWith("const x", {
      lang: "typescript",
      theme: "catppuccin-mocha",
    });
  });

  it("returns null without calling the loader for an unknown language", async () => {
    const { loader } = fakeLoader([]);

    await expect(highlightCode("x", "brainfuck", loader)).resolves.toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns null without calling the loader when a skip reason applies", async () => {
    const { loader } = fakeLoader([]);

    await expect(
      highlightCode("a".repeat(MAX_HIGHLIGHT_BYTES + 1), "typescript", loader),
    ).resolves.toBeNull();
    await expect(
      highlightCode("\n".repeat(MAX_HIGHLIGHT_LINES), "typescript", loader),
    ).resolves.toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns null when the loader rejects", async () => {
    const loader: HighlightLoader = vi.fn(() => Promise.reject(new Error("chunk failed")));

    await expect(highlightCode("x", "typescript", loader)).resolves.toBeNull();
  });

  it("returns null when codeToTokens throws", async () => {
    const loader: HighlightLoader = vi.fn(async () => ({
      codeToTokens: () => {
        throw new Error("grammar missing");
      },
    }));

    await expect(highlightCode("x", "typescript", loader)).resolves.toBeNull();
  });
});
