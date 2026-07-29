import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { resolveChunkGroup } from "./src/build/chunk-groups";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        // Explicit groups must not absorb shared stores or Tauri modules. Once
        // dependency recursion is disabled, preserve their source import order
        // across the linked chunks instead.
        strictExecutionOrder: true,
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [{ name: resolveChunkGroup }],
        },
      },
    },
  },
});
