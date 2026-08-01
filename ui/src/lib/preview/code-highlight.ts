import type { LanguageInput } from "shiki/core";
import { fileExtension } from "../file-viewer";

/**
 * Syntax highlighting for the file preview, exposed as tokens.
 *
 * ADR-0109: this module must never produce an HTML string. Only shiki's
 * `codeToTokens` is used — never `codeToHtml` — so the consumer can render
 * plain React `<span>`s and no `dangerouslySetInnerHTML` is needed anywhere in
 * the preview path.
 */

export interface HighlightToken {
  content: string;
  /** CSS color from the theme; absent means default foreground. */
  color?: string;
  fontStyle?: "italic" | "bold" | "underline";
}

/** Loads a highlighter for one language. Injectable so tests never load shiki. */
export type HighlightLoader = (language: string) => Promise<{
  codeToTokens(
    code: string,
    options: { lang: string; theme: string },
  ): { tokens: HighlightToken[][] };
}>;

export const MAX_HIGHLIGHT_BYTES = 300_000;
export const MAX_HIGHLIGHT_LINES = 10_000;

const THEME = "catppuccin-mocha";

/**
 * Every grammar is a separate dynamic `import()` of a literal specifier.
 * A template literal (`` import(`shiki/langs/${id}.mjs`) ``) is not statically
 * analyzable for a bare specifier, so Rolldown cannot code-split it — and
 * `ui/vite.config.ts` runs with `includeDependenciesRecursively: false`, which
 * makes an unsplittable grammar barrel land in the main bundle. Keep the map
 * explicit even though it is long.
 *
 * Each entry is a shiki "getter" `LanguageInput`, so the grammar chunk is only
 * fetched once the highlighter actually needs it.
 */
const LANGUAGE_IMPORTS: Record<string, LanguageInput> = {
  astro: () => import("shiki/langs/astro.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  nushell: () => import("shiki/langs/nushell.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  viml: () => import("shiki/langs/viml.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".astro": "astro",
  ".bash": "shellscript",
  ".bat": "bat",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".clj": "clojure",
  ".cmake": "cmake",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".dart": "dart",
  ".dockerfile": "docker",
  ".erl": "erlang",
  ".ex": "elixir",
  ".exs": "elixir",
  ".fish": "fish",
  ".go": "go",
  ".graphql": "graphql",
  ".h": "c",
  ".hcl": "hcl",
  ".hpp": "cpp",
  ".hs": "haskell",
  ".ini": "ini",
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".jsx": "jsx",
  ".kt": "kotlin",
  ".less": "less",
  ".lua": "lua",
  ".make": "makefile",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".nu": "nushell",
  ".php": "php",
  ".proto": "proto",
  ".ps1": "powershell",
  ".py": "python",
  ".r": "r",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".scss": "scss",
  ".sh": "shellscript",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".tf": "terraform",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".vim": "viml",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
  ".zsh": "shellscript",
};

/** Shiki language id for a path, or null when the extension has no grammar. */
export function previewLanguage(path: string): string | null {
  return EXTENSION_LANGUAGES[fileExtension(path)] ?? null;
}

/** Why highlighting was skipped, or null when it can run. */
export function highlightSkipReason(code: string): "too-large" | "too-many-lines" | null {
  if (utf8ByteLength(code) > MAX_HIGHLIGHT_BYTES) return "too-large";
  if (countLines(code) > MAX_HIGHLIGHT_LINES) return "too-many-lines";
  return null;
}

/** Token lines, or null when highlighting was skipped or the loader failed. */
export async function highlightCode(
  code: string,
  language: string,
  loader: HighlightLoader = defaultHighlightLoader,
): Promise<HighlightToken[][] | null> {
  if (highlightSkipReason(code) !== null) return null;
  // Gate on the static map even for injected loaders: an id with no grammar
  // entry can never be highlighted, so there is nothing to load.
  if (!Object.hasOwn(LANGUAGE_IMPORTS, language)) return null;

  try {
    const highlighter = await loader(language);
    return highlighter.codeToTokens(code, { lang: language, theme: THEME }).tokens;
  } catch {
    // The caller falls back to plain source; a failed grammar chunk is not
    // worth a console entry on every reopen.
    return null;
  }
}

/**
 * One highlighter per language, keyed on the in-flight promise so two panes
 * opening the same file do not build the grammar twice. A rejected build is
 * evicted so a later open can retry instead of inheriting the failure forever.
 */
const highlighterCache = new Map<string, ReturnType<HighlightLoader>>();

const defaultHighlightLoader: HighlightLoader = (language) => {
  const cached = highlighterCache.get(language);
  if (cached) return cached;

  const created = createDefaultHighlighter(language);
  highlighterCache.set(language, created);
  created.catch(() => highlighterCache.delete(language));
  return created;
};

async function createDefaultHighlighter(
  language: string,
): Promise<Awaited<ReturnType<HighlightLoader>>> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);

  const core = await createHighlighterCore({
    langs: [LANGUAGE_IMPORTS[language]],
    themes: [import("shiki/themes/catppuccin-mocha.mjs")],
    engine: createJavaScriptRegexEngine(),
  });

  // Adapt shiki's tokens: its `fontStyle` is a numeric TextMate bit mask, while
  // the consumer renders a CSS keyword.
  return {
    codeToTokens(code, options) {
      const { tokens } = core.codeToTokens(code, options);
      return {
        tokens: tokens.map((line) =>
          line.map((token) => {
            const mapped: HighlightToken = { content: token.content };
            if (token.color) mapped.color = token.color;
            const fontStyle = fontStyleKeyword(token.fontStyle);
            if (fontStyle) mapped.fontStyle = fontStyle;
            return mapped;
          }),
        ),
      };
    },
  };
}

// TextMate FontStyle flags (@shikijs/vscode-textmate): Italic 1, Bold 2,
// Underline 4. It is a `const enum` in a .d.ts, so it cannot be imported as a
// value under `isolatedModules`.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

function fontStyleKeyword(fontStyle: number | undefined): HighlightToken["fontStyle"] {
  if (fontStyle === undefined || fontStyle <= 0) return undefined;
  if (fontStyle & FONT_STYLE_ITALIC) return "italic";
  if (fontStyle & FONT_STYLE_BOLD) return "bold";
  if (fontStyle & FONT_STYLE_UNDERLINE) return "underline";
  return undefined;
}

function utf8ByteLength(text: string): number {
  // The limit guards tokenizer cost, which tracks bytes on disk rather than
  // UTF-16 code units — a CJK file is three times heavier than its `.length`.
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one 4-byte code point, consume both halves.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}
