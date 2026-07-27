import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // `*.screen.test.ts` drives a real xterm instance and belongs to the screen
    // suite (`vitest.screen.config.ts`, `npm run test:screen`, ADR-0074).
    exclude: ["e2e/**", "node_modules/**", "src/**/*.screen.test.{ts,tsx}"],
  },
});
