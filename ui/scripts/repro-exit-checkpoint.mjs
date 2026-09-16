/* global fetch, window, setTimeout */
// From ui/: LAYMUX_REPRO_ISOLATED=1 node scripts/repro-exit-checkpoint.mjs
// <matrix workspace id|all> <isolated settings.json> [race|on|off]
// Requires real, resumable agents already configured in the target workspaces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [workspaceId, settingsPath, mode = "race"] = process.argv.slice(2);
assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1");
assert(["race", "on", "off"].includes(mode));
const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const trace = [];
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:1420"));
  assert(page);
  await page.exposeFunction("__recordExitRepro", (event) =>
    trace.push({ ...event, time: Date.now() }),
  );
  await page.route("**/src/lib/tauri-api.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    assert(source.includes("import { invoke }"));
    await route.fulfill({
      response,
      body:
        source.replace("import { invoke }", "import { invoke as realInvoke }") +
        "\nconst invoke=(cmd,args,...rest)=>window.__exitReproInvoke?window.__exitReproInvoke(realInvoke,cmd,args,...rest):realInvoke(cmd,args,...rest);",
    });
  });
  await page.reload();
  const ids = await page.evaluate(
    async ({ workspaceId, mode }) => {
      const { useWorkspaceStore: ws } = await import("/src/stores/workspace-store.ts");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          ws
            .getState()
            .workspaces.some((workspace) =>
              workspaceId === "all"
                ? workspace.name.startsWith("matrix-")
                : workspace.id === workspaceId,
            )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ws.getState().workspaces.every((w) => w.name.startsWith("matrix-")))
        throw Error("Matrix-owned workspaces required");
      const targets = ws
        .getState()
        .workspaces.filter((w) => workspaceId === "all" || w.id === workspaceId);
      if (!targets.length) throw Error("Workspace missing");
      const record = window.__recordExitRepro;
      let injected = false;
      window.__exitReproInvoke = async (invoke, command, args, ...rest) => {
        if (command === "interrupt_terminal_on_exit" || command === "save_settings") {
          await record({ command, phase: "begin", terminalId: args?.id });
        }
        if (mode === "race" && command === "interrupt_terminal_on_exit" && !injected) {
          injected = true;
          setTimeout(async () => {
            await record({ command: "injected-watchdog" });
            const { emit } = await import("/node_modules/.vite/deps/@tauri-apps_api_event.js");
            // Only the arrival time is injected; attribution and disk writes are real.
            // Rust rejects this synthetic request's ACK because it has no pending waiter.
            await emit("session-checkpoint-requested", {
              requestId: 900001,
              reason: "watchdog",
              requireConclusive: false,
            });
          }, 800);
        }
        const result = await invoke(command, args, ...rest);
        if (command === "get_terminal_session_attributions") await record({ command, result });
        if (command === "save_settings") await record({ command, phase: "end" });
        return result;
      };
      for (const target of targets) {
        ws.getState().setActiveWorkspace(target.id);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return targets
        .flatMap((target) => target.panes)
        .filter((p) => p.view.type === "TerminalView")
        .map((p) => `terminal-${p.id}`);
    },
    { workspaceId, mode },
  );
  assert(ids.length > 0);
  let expected;
  for (let attempt = 0; attempt < 80; attempt++) {
    expected = await page.evaluate(async () =>
      (await import("/src/lib/tauri-api.ts")).getTerminalSessionAttributions(),
    );
    if (ids.every((id) => expected[id]?.state === "identified")) break;
    await page.waitForTimeout(500);
  }
  assert(ids.every((id) => expected[id]?.state === "identified"));
  // Startup grace hides the bug by preserving noAgent/unidentified observations.
  await page.waitForTimeout(17000);
  await page.evaluate(async (enabled) => {
    const { useSettingsStore: settings } = await import("/src/stores/settings-store.ts");
    settings
      .getState()
      .setExit({ interruptTerminals: enabled, interruptRounds: 3, settleMs: 2000 });
  }, mode !== "off");
  const closed = page.waitForEvent("close", { timeout: 30000 });
  await page
    .evaluate(async () => {
      const { getCurrentWindow } =
        await import("/node_modules/.vite/deps/@tauri-apps_api_window.js");
      await getCurrentWindow().close();
    })
    .catch(() => {});
  await closed;
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  const fields = {
    codex: "lastCodexSession",
    claude: "lastClaudeSession",
    grok: "lastGrokSession",
  };
  const changed = ids.filter((id) => {
    const view = saved.workspaces
      .flatMap((w) => w.panes)
      .find((p) => `terminal-${p.id}` === id)?.view;
    return view?.[fields[expected[id].provider]] !== expected[id].sessionId;
  });
  console.log(JSON.stringify({ instance: health.instance, mode, ids, expected, changed, trace }));
  assert.equal(changed.length, 0, "Close checkpoint was overwritten after Ctrl+C");
  if (mode === "race") assert(trace.some((e) => e.command === "injected-watchdog"));
} finally {
  await browser.close();
}
