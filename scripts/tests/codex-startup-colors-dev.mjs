// Windows dev 전용. 실제 Codex와 WebView stall로 ADR-0375를 검증한다.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { connectDevPage } from "./dev-cdp.mjs";
import { api, until, sleep } from "./fixtures/graceful-close-dev.mjs";

const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  process.cwd().toLowerCase(),
);
const page = await connectDevPage(
  process.env.LAYMUX_CODEX_COLOR_CDP ?? "http://127.0.0.1:19381",
  process.env.LAYMUX_CODEX_COLOR_PAGE ?? "http://localhost:1427",
);
const artifactDir = ".screenshots/codex-startup-colors";
await fs.mkdir(artifactDir, { recursive: true });
const created = [];
let original;
try {
  const config = await page.evaluate(async () => {
    const { useWorkspaceStore } =
      await import("/src/stores/workspace-store.ts");
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    const settings = useSettingsStore.getState();
    const profile = settings.profiles.find((p) =>
      /^powershell(?:\.exe)?\b/i.test(p.commandLine),
    );
    return {
      original: useWorkspaceStore.getState().activeWorkspaceId,
      profile: profile?.name,
      command: settings.codex.command,
    };
  });
  original = config.original;
  assert.ok(config.profile, "native PowerShell profile is required");
  const results = [];
  for (const mode of ["manual", "restore", "restore-stall"]) {
    const { workspace } = await api("/workspaces", {
      name: `Codex-colors-${mode}`,
    });
    created.push(workspace.id);
    const id = await page.evaluate(
      async ({ workspaceId, profile, mode, cwd }) => {
        window.codexColorStall = null;
        const { useWorkspaceStore } =
          await import("/src/stores/workspace-store.ts");
        const w = useWorkspaceStore.getState();
        const ws = w.workspaces.find(
          (candidate) => candidate.id === workspaceId,
        );
        if (!ws)
          throw new Error(
            "CDP store and Automation bridge differ; restart dev Vite to clear HMR module versions",
          );
        const layer = ws.panes[0].layers[0];
        w.setPaneView(
          0,
          {
            type: "TerminalView",
            profile,
            lastCwd: cwd,
            ...(mode !== "manual" ? { lastAgentFresh: "codex" } : {}),
          },
          layer.id,
          workspaceId,
        );
        return `terminal-${layer.id}`;
      },
      {
        workspaceId: workspace.id,
        profile: config.profile,
        mode,
        cwd: process.cwd(),
      },
    );
    if (mode === "restore-stall") {
      await page.evaluate(() => {
        window.codexColorStall = null;
        setTimeout(() => {
          const start = Date.now();
          const monotonic = performance.now();
          while (performance.now() - monotonic < 1600) {
            /* intentional WebView stall */
          }
          window.codexColorStall = {
            start,
            end: Date.now(),
            durationMs: performance.now() - monotonic,
          };
        }, 300);
      });
    }
    await api("/workspaces/active", { id: workspace.id });
    if (mode === "manual") {
      await until(
        async () =>
          JSON.stringify(
            await api(`/terminals/${id}/output?lines=30`),
          ).includes("PS "),
        "shell prompt",
      );
      await api(`/terminals/${id}/write`, {
        data: `${config.command || "codex"}\r`,
      });
    }
    await until(
      async () => {
        const state = await page.evaluate(async (id) => {
          const { getTerminalSerializeMap, getTerminalInspector } =
            await import("/src/lib/terminal-serialize-registry.ts");
          return {
            bytes: getTerminalSerializeMap().get(id)?.(),
            lines: getTerminalInspector(id)?.(100)
              .lines.filter((line) => line.text)
              .map((line) => line.text),
            stall: window.codexColorStall,
          };
        }, id);
        return (
          state.lines?.some((line) =>
            line.includes("Ask Codex to do anything"),
          ) && state
        );
      },
      `${mode} Codex composer`,
      60000,
    );
    await sleep(2000); // let any late reply reach the composer before asserting
    const final = await page.evaluate(async (id) => {
      const { getTerminalSerializeMap, getTerminalInspector } =
        await import("/src/lib/terminal-serialize-registry.ts");
      return {
        bytes: getTerminalSerializeMap().get(id)?.(),
        lines: getTerminalInspector(id)?.(100).lines.map((line) => line.text),
        stall: window.codexColorStall,
      };
    }, id);
    assert.ok(
      !final.lines.some((line) => /\](?:10|11);rgb:/.test(line)),
      "no color reply in composer",
    );
    const backgrounds = [
      ...new Set(
        [...final.bytes.matchAll(/48;2;(\d+);(\d+);(\d+)/g)].map((m) =>
          m.slice(1).join(";"),
        ),
      ),
    ];
    assert.ok(
      backgrounds.length,
      `${mode}: composer must have a theme-derived RGB fill`,
    );
    if (mode === "restore-stall") assert.ok(final.stall?.durationMs >= 1600);
    if (mode === "restore-stall" && process.env.LAYMUX_CODEX_COLOR_LOG) {
      const log = await fs.readFile(process.env.LAYMUX_CODEX_COLOR_LOG, "utf8");
      const query = log
        .split("\n")
        .find((line) => line.includes(id) && line.includes("]10;?"));
      const queryAt = Date.parse(
        query?.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0] ?? "",
      );
      assert.ok(
        queryAt >= final.stall.start && queryAt <= final.stall.end,
        "raw color query must overlap the measured WebView stall",
      );
    }
    const screenshot = (await api("/screenshot", {})).path;
    const { data: inventory } = await api("/pty-sessions");
    const owner = inventory.sessions.some(
      (session) => session.terminalId === id,
    )
      ? "daemon"
      : "local";
    if (process.env.LAYMUX_CODEX_COLOR_EXPECT_OWNER)
      assert.equal(owner, process.env.LAYMUX_CODEX_COLOR_EXPECT_OWNER);
    const result = {
      mode,
      owner,
      workspaceId: workspace.id,
      terminalId: id,
      backgrounds,
      stall: final.stall,
      screenshot,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  assert.deepEqual(results[1].backgrounds, results[0].backgrounds);
  assert.deepEqual(results[2].backgrounds, results[0].backgrounds);
  await fs.writeFile(
    path.join(artifactDir, `result-${Date.now()}.json`),
    JSON.stringify({ instance: health.instance, results }, null, 2),
  );
} finally {
  if (original) await api("/workspaces/active", { id: original });
  if (process.argv.includes("--cleanup")) {
    for (const id of created)
      await api(`/workspaces/${id}`, undefined, "DELETE");
  }
  page.close();
}
