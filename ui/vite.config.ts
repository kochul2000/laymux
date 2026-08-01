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
    // Raised above the 500 kB default for one reason: syntax grammars. Each is
    // its own lazily-imported chunk and the largest (C++, whose TextMate rules
    // embed several other languages) is ~800 kB. Nothing downloads it — the
    // desktop app ships its assets locally — and it is only parsed if someone
    // opens a C++ file. The budget that actually matters, the entry chunk's
    // static import closure, is asserted at 500 kB in production-bundle.test.ts.
    chunkSizeWarningLimit: 1000,
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
