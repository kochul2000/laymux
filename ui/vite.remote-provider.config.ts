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
  },
});
