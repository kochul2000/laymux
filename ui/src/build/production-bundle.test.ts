import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, type ResolvedConfig } from "vite";
import { describe, expect, it } from "vitest";

const LARGE_CHUNK_WARNING = /Some chunks are larger than/;
const SETTINGS_VIEW_SUFFIX = "/src/components/views/SettingsView.tsx";
const UI_ROOT = process.cwd();

interface ChunkOutput {
  type: "chunk";
  fileName: string;
  code: string;
  isEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, unknown>;
}

interface AssetOutput {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

type BundleOutput = ChunkOutput | AssetOutput;

interface BuildLog {
  level: string;
  code?: string;
  message: string;
}

async function runProductionBuild(outDir: string, chunkSizeWarningLimit?: number) {
  const logs: BuildLog[] = [];
  let resolvedConfig: ResolvedConfig | undefined;
  const result = await build({
    logLevel: "silent",
    plugins: [
      {
        name: "test:capture-production-config",
        configResolved(config) {
          resolvedConfig = config;
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      write: true,
      ...(chunkSizeWarningLimit === undefined ? {} : { chunkSizeWarningLimit }),
      rolldownOptions: {
        onLog(level, log, handler) {
          logs.push({ level, code: log.code, message: log.message });
          handler(level, log);
        },
      },
    },
  });
  if (!resolvedConfig) throw new Error("Vite did not resolve the production config");

  const buildResults = (Array.isArray(result) ? result : [result]) as unknown as Array<{
    output: BundleOutput[];
  }>;
  return {
    logs,
    resolvedConfig,
    outputs: buildResults.flatMap(({ output }) => output),
  };
}

describe("production UI bundle", () => {
  it("keeps the explicit Settings chunk narrow, static, and Tauri-bundled", async () => {
    const tempOutDir = await mkdtemp(path.join(tmpdir(), "laymux-production-bundle-"));
    try {
      const production = await runProductionBuild(path.join(tempOutDir, "production"));
      const chunks = production.outputs.filter(
        (output): output is ChunkOutput => output.type === "chunk",
      );
      const entry = chunks.find((chunk) => chunk.isEntry);
      const settings = chunks.find((chunk) => chunk.fileName.includes("settings-view"));
      const warningLimitBytes = production.resolvedConfig.build.chunkSizeWarningLimit * 1000;

      expect(entry).toBeDefined();
      expect(settings).toBeDefined();
      expect(
        chunks
          .filter((chunk) => Buffer.byteLength(chunk.code, "utf8") > warningLimitBytes)
          .map((chunk) => chunk.fileName),
      ).toEqual([]);
      expect(production.logs.filter((log) => LARGE_CHUNK_WARNING.test(log.message))).toEqual([]);

      const settingsModules = Object.keys(settings?.modules ?? {}).map((id) =>
        id.replaceAll("\\", "/"),
      );
      expect(settingsModules).toHaveLength(1);
      expect(settingsModules[0]?.endsWith(SETTINGS_VIEW_SUFFIX)).toBe(true);

      expect(entry?.imports).toContain(settings?.fileName);
      expect(entry?.dynamicImports).not.toContain(settings?.fileName);
      expect(settings?.dynamicImports).toEqual([]);

      const moduleOwners = new Map<string, string>();
      for (const chunk of chunks) {
        for (const moduleId of Object.keys(chunk.modules)) {
          expect(
            moduleOwners.get(moduleId),
            `${moduleId} is duplicated across chunks`,
          ).toBeUndefined();
          moduleOwners.set(moduleId, chunk.fileName);
        }
      }
      expect(
        production.logs.filter((log) => /circular/i.test(`${log.code ?? ""} ${log.message}`)),
      ).toEqual([]);

      const htmlAsset = production.outputs.find(
        (output): output is AssetOutput =>
          output.type === "asset" && output.fileName === "index.html",
      );
      const html = typeof htmlAsset?.source === "string" ? htmlAsset.source : "";
      expect(html).toContain(`/assets/${path.basename(settings?.fileName ?? "")}`);

      const tauriConfig = JSON.parse(
        await readFile(path.resolve(UI_ROOT, "../src-tauri/tauri.conf.json"), "utf8"),
      ) as { build?: { frontendDist?: string } };
      expect(tauriConfig.build?.frontendDist).toBe("../ui/dist");

      const largestChunkBytes = Math.max(
        ...chunks.map((chunk) => Buffer.byteLength(chunk.code, "utf8")),
      );
      const warningCanaryLimitBytes = largestChunkBytes - 1;
      const warningCanary = await runProductionBuild(
        path.join(tempOutDir, "warning-canary"),
        warningCanaryLimitBytes / 1000,
      );
      expect(warningCanary.resolvedConfig.build.chunkSizeWarningLimit * 1000).toBeCloseTo(
        warningCanaryLimitBytes,
        6,
      );
      expect(warningCanary.logs.filter((log) => LARGE_CHUNK_WARNING.test(log.message))).not.toEqual(
        [],
      );
    } finally {
      await rm(tempOutDir, { recursive: true, force: true });
      await expect(access(tempOutDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
