import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Screen suite — tests that stream bytes into a real `@xterm/xterm` and assert
 * on its cell grid or renderer contract (`*.screen.test.ts`, ADR-0074/0079).
 *
 * Separate from `vitest.config.ts` for two reasons. It is excluded there, so
 * `npx vitest run` keeps its runtime and its meaning ("does the app wire up
 * correctly") while this suite answers a different question ("what do these
 * bytes do to the screen"). It needs none of the default React/i18n setup.
 * Cell-grid tests keep terminals unopened; renderer-contract tests may call
 * `open()` and install only the browser shims they exercise locally.
 *
 * Run: `npm run test:screen` (from `ui/`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Exercise the same patched ESM engine Vite ships to the desktop.
      "@xterm/xterm": path.resolve(__dirname, "node_modules/@xterm/xterm/lib/xterm.mjs"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.screen.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
