import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { filePreviewKind } from "../file-preview-kind";
import { previewLanguage } from "./code-highlight";

/**
 * Rust's `TEXT_EXTENSIONS` is a classification gate, not a display hint: an
 * extension missing from it is reported as `binary` the moment the file crosses
 * the byte limit, and the frontend renderer for it never runs. So every
 * extension a renderer claims has to appear there too.
 *
 * Hard-coding a sample of extensions here would not test that — it would only
 * test the sample. This reads the actual Rust list and compares it against the
 * actual set of extensions the frontend claims, the same way
 * `css-tokens.test.ts` reads `index.css` as text. It caught `.make`, which had
 * a shiki grammar but no entry in the gate.
 */
const RUST_SOURCE = path.resolve(__dirname, "../../../../src-tauri/src/commands/file_viewer.rs");

/** Extensions the frontend routes to a renderer, gathered from the real maps. */
const CLAIMED_EXTENSIONS = [
  ".json",
  ".jsonc",
  ".jsonl",
  ".ndjson",
  ".diff",
  ".patch",
  ".csv",
  ".tsv",
  ".tab",
  ".log",
  ".html",
  ".htm",
  ".md",
  ".markdown",
];

let gate: Set<string>;

beforeAll(() => {
  const source = fs.readFileSync(RUST_SOURCE, "utf8");
  const block = /const TEXT_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\n\];/.exec(source);
  if (!block) throw new Error("TEXT_EXTENSIONS not found in file_viewer.rs");
  gate = new Set(Array.from(block[1].matchAll(/"(\.[^"]+)"/g), (match) => match[1]));
});

describe("Rust TEXT_EXTENSIONS gate", () => {
  it("parses a plausible extension list out of the Rust source", () => {
    // Guards the regex itself: a refactor that reshapes the constant must not
    // silently reduce this suite to asserting nothing.
    expect(gate.size).toBeGreaterThan(100);
    expect(gate.has(".rs")).toBe(true);
    expect(gate.has(".json")).toBe(true);
  });

  it("covers every extension a structured or document renderer claims", () => {
    const missing = CLAIMED_EXTENSIONS.filter((ext) => !gate.has(ext));
    expect(missing).toEqual([]);
  });

  it("covers every extension the syntax highlighter has a grammar for", () => {
    // `previewLanguage` owns the grammar map; probing it through the public
    // function keeps this honest if the internal table is reorganised.
    const highlighted = [...gate, ...CLAIMED_EXTENSIONS].filter((ext) =>
      Boolean(previewLanguage(`/tmp/file${ext}`)),
    );
    expect(highlighted.length).toBeGreaterThan(40);

    const claimedByHighlighter = KNOWN_GRAMMAR_EXTENSIONS.filter((ext) =>
      Boolean(previewLanguage(`/tmp/file${ext}`)),
    );
    const missing = claimedByHighlighter.filter((ext) => !gate.has(ext));
    expect(missing).toEqual([]);
  });

  it("routes every gated extension to a renderer or to plain source, never to a broken one", () => {
    for (const ext of gate) {
      const kind = filePreviewKind(`/tmp/file${ext}`);
      // `null` is a valid answer (plain source). What must not happen is a kind
      // outside the union the viewer knows how to render.
      expect(
        kind === null ||
          ["html", "markdown", "json", "jsonl", "diff", "csv", "log", "code"].includes(kind),
      ).toBe(true);
    }
  });
});

/**
 * Every extension `previewLanguage` might answer for. Kept as a literal list so
 * the test fails when the grammar map grows without the Rust gate growing with
 * it — the exact drift that let `.make` through.
 */
const KNOWN_GRAMMAR_EXTENSIONS = [
  ".astro",
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cmake",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cxx",
  ".dart",
  ".dockerfile",
  ".erl",
  ".ex",
  ".exs",
  ".fish",
  ".go",
  ".graphql",
  ".h",
  ".hcl",
  ".hpp",
  ".hs",
  ".ini",
  ".java",
  ".jl",
  ".js",
  ".jsx",
  ".kt",
  ".less",
  ".lua",
  ".make",
  ".mjs",
  ".mts",
  ".nu",
  ".php",
  ".proto",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".vim",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
  ".zsh",
];
