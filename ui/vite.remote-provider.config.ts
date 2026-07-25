import { defineConfig } from "vite";
import path from "path";

/**
 * Builds the shared cell-width provider into the Rust server's asset directory
 * (issue #538).
 *
 * The Direct Remote Mode client is served by `axum` with `include_str!`, so the
 * asset has to exist as a committed file. Generating it from
 * `src/lib/terminal-unicode-width.ts` keeps a single source for the width
 * contract; `src/lib/remote-unicode-provider.test.ts` fails if the committed
 * output no longer matches that source.
 *
 * IIFE, not ESM: `page.html` loads classic `<script>` tags.
 */
/**
 * The output lives in the Rust source tree, so it reads like something to
 * hand-edit. A hand edit would pass the drift test as long as behaviour matched,
 * then vanish on the next rebuild — say so at the top of the file.
 */
const BANNER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Source: ui/src/lib/terminal-unicode-width.ts",
  "//         via ui/src/remote/unicode-provider-entry.ts",
  "// Rebuild: cd ui && npm run build:remote-provider",
  "// Drift from the source is caught by ui/src/lib/remote-unicode-provider.test.ts",
].join("\n");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    emptyOutDir: false,
    outDir: path.resolve(__dirname, "../src-tauri/src/remote_server/assets"),
    lib: {
      entry: path.resolve(__dirname, "./src/remote/unicode-provider-entry.ts"),
      formats: ["iife"],
      name: "LaymuxUnicodeProviderBundle",
      fileName: () => "unicode-provider.js",
    },
    // The asset is committed and diffed, so keep it readable rather than minified.
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // The file lives in the Rust source tree, so it reads like something to
        // hand-edit. A hand edit would pass the drift test as long as behaviour
        // matched, then vanish on the next rebuild — say so at the top.
        banner: BANNER,
      },
    },
  },
});
