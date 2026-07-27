import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Screen suite — tests that stream bytes into a real `@xterm/xterm` and assert
 * on the resulting cell grid (`*.screen.test.ts`, ADR-0074).
 *
 * Separate from `vitest.config.ts` for two reasons. It is excluded there, so
 * `npx vitest run` keeps its runtime and its meaning ("does the app wire up
 * correctly") while this suite answers a different question ("what do these
 * bytes do to the screen"). And it needs none of the default setup — no React
 * plugin, no i18n, no jest-dom, no ResizeObserver shim — because nothing here
 * renders a component; a `Terminal` is constructed without `open()`.
 *
 * Run: `npm run test:screen` (from `ui/`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.screen.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
