import { defineConfig } from "vite";
import path from "path";

/**
 * Minifies the Direct Remote Mode client (ADR-0169) into the Rust server's
 * asset directory, following the `vite.remote-provider.config.ts` pattern:
 * the server embeds assets with `include_bytes!`, so the minified output has
 * to exist as a committed file.
 *
 * Sources and artifacts both live in `src-tauri/src/remote_server/assets/` —
 * `remote-app.{js,css}` are the hand-edited sources, `remote-app.min.{js,css}`
 * are generated here. `scripts/stamp-remote-page.mjs` prepends the
 * generated-file banner with the source hashes afterwards (the minifier strips
 * banner comments), and `src/remote/remote-page-bundle.test.ts` fails when the
 * committed artifacts drift from the sources.
 */
const ASSETS_DIR = path.resolve(__dirname, "../src-tauri/src/remote_server/assets");

export default defineConfig({
  // Without this the build copies ui/public/* into the Rust asset directory.
  publicDir: false,
  build: {
    emptyOutDir: false,
    outDir: ASSETS_DIR,
    lib: {
      entry: path.resolve(__dirname, "./src/remote/page-entry.js"),
      formats: ["iife"],
      name: "LaymuxRemotePageBundle",
      fileName: () => "remote-app.min.js",
    },
    minify: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        assetFileNames: "remote-app.min[extname]",
      },
    },
  },
});
