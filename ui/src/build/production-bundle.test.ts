import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const MAX_CHUNK_BYTES = 500 * 1024;
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

describe("production UI bundle", () => {
  it("keeps the explicit Settings chunk narrow, static, and Tauri-bundled", async () => {
    const logs: Array<{ level: string; code?: string; message: string }> = [];
    const result = await build({
      logLevel: "silent",
      build: {
        write: false,
        rolldownOptions: {
          onLog(level, log, handler) {
            logs.push({ level, code: log.code, message: log.message });
            handler(level, log);
          },
        },
      },
    });
    const buildResults = (Array.isArray(result) ? result : [result]) as unknown as Array<{
      output: BundleOutput[];
    }>;
    const outputs = buildResults.flatMap(({ output }) => output);
    const chunks = outputs.filter((output): output is ChunkOutput => output.type === "chunk");
    const entry = chunks.find((chunk) => chunk.isEntry);
    const settings = chunks.find((chunk) => chunk.fileName.includes("settings-view"));

    expect(entry).toBeDefined();
    expect(settings).toBeDefined();
    expect(
      chunks.filter((chunk) => chunk.code.length >= MAX_CHUNK_BYTES).map((chunk) => chunk.fileName),
    ).toEqual([]);

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
    expect(logs.filter((log) => /circular/i.test(`${log.code ?? ""} ${log.message}`))).toEqual([]);

    const htmlAsset = outputs.find(
      (output): output is AssetOutput =>
        output.type === "asset" && output.fileName === "index.html",
    );
    const html = typeof htmlAsset?.source === "string" ? htmlAsset.source : "";
    expect(html).toContain(`/assets/${path.basename(settings?.fileName ?? "")}`);

    const tauriConfig = JSON.parse(
      await readFile(path.resolve(UI_ROOT, "../src-tauri/tauri.conf.json"), "utf8"),
    ) as { build?: { frontendDist?: string } };
    expect(tauriConfig.build?.frontendDist).toBe("../ui/dist");
  });
});
