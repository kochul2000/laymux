/* global fetch, window, setTimeout, performance */
// Run against an isolated dev profile and WebView2 CDP port 9229 only.
// Injects attribution failures in the WebView IPC adapter; production Rust
// eviction, human input, and PTY writers remain real.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
const instance = health.instance ?? health.data?.instance;
assert.equal(instance?.buildKind, "dev", "release instances must not be modified");
assert(
  instance?.worktreeRoot?.replaceAll("\\", "/").toLowerCase() ===
    process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
  "unexpected dev worktree",
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((item) => item.url().startsWith("http://localhost:1420"));
assert(page, "dev WebView not found");
await page.route("**/src/lib/tauri-api.ts*", async (route) => {
  const response = await route.fetch();
  const original = await response.text();
  assert(original.includes("import { invoke }"), "unexpected dev IPC module");
  const body =
    original.replace("import { invoke }", "import { invoke as realInvoke }") +
    `
const invoke = async (command, args, options) => {
  const r = window.__evictionRepro;
  if (r?.inject && command === 'get_terminal_session_attributions') {
    await new Promise(resolve => setTimeout(resolve, 3000));
    throw new Error('repro: attribution unavailable');
  }
  if (r?.inject && command === 'checkpoint_and_close_hidden_terminals') {
    r.requests.push(args);
    try { return await realInvoke(command, args, options); }
    catch(error) { r.failures.push(String(error)); throw error; }
  }
  return realInvoke(command, args, options);
};`;
  await route.fulfill({ response, body });
});
await page.reload();
await page.waitForTimeout(2_000);
try {
  const setup = await page.evaluate(async () => {
    const { useWorkspaceStore: workspaces } = await import("/src/stores/workspace-store.ts");
    const { useSettingsStore: settings } = await import("/src/stores/settings-store.ts");
    const { useUiStore: ui } = await import("/src/stores/ui-store.ts");
    const { useTerminalStore: terminals } = await import("/src/stores/terminal-store.ts");
    const { focusWorkspacePane } = await import("/src/lib/workspace-transition.ts");
    const profile = settings.getState().profiles.find((p) => /powershell/i.test(p.name));
    if (!profile) throw new Error("PowerShell profile required");
    const suffix = Date.now().toString(36);
    const make = (kind) => ({
      id: `repro-${kind}-${suffix}`,
      name: `Repro-${kind}`,
      panes: [
        {
          id: `repro-${kind}-pane-${suffix}`,
          x: 0,
          y: 0,
          w: 12,
          h: 12,
          view: {
            type: "TerminalView",
            profile: profile.name,
            inputMode: "direct",
            ...(kind === "unvisited" ? { lastCodexSession: "saved-unvisited-repro" } : {}),
          },
        },
      ],
    });
    const visible = make("visible"),
      hidden = make("hidden"),
      unvisited = make("unvisited");
    workspaces.setState({
      workspaces: [...workspaces.getState().workspaces, visible, hidden, unvisited],
    });
    settings.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
    focusWorkspacePane(hidden.id, 0);
    window.__evictionRepro = {
      workspaces,
      settings,
      ui,
      terminals,
      focusWorkspacePane,
      visible,
      hidden,
      unvisited,
      failures: [],
      requests: [],
      inject: false,
    };
    return {
      hiddenId: `terminal-${hidden.panes[0].id}`,
      visibleId: `terminal-${visible.panes[0].id}`,
    };
  });
  await page.waitForFunction(
    (id) =>
      window.__evictionRepro.terminals
        .getState()
        .instances.some((t) => t.id === id && t.sessionReady),
    setup.hiddenId,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
  await page.evaluate(() => {
    const r = window.__evictionRepro;
    r.focusWorkspacePane(r.visible.id, 0);
  });
  await page.waitForFunction(
    (id) =>
      window.__evictionRepro.terminals
        .getState()
        .instances.some((t) => t.id === id && t.sessionReady),
    setup.visibleId,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
  await page.evaluate(() => {
    const r = window.__evictionRepro;
    r.inject = true;
    r.ui.getState().setWorkspaceHidden(r.hidden.id, true);
    r.ui.getState().setWorkspaceHidden(r.unvisited.id, true);
    r.settings.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 1 });
  });
  const result = await page.evaluate(async ({ visibleId }) => {
    const r = window.__evictionRepro;
    const api = await import("/src/lib/tauri-api.ts");
    const errors = [];
    let raw = 0,
      paste = 0;
    const started = performance.now();
    while (performance.now() - started < 25_000) {
      try {
        await api.writeToTerminal(visibleId, "a");
        raw += 1;
      } catch (e) {
        errors.push(String(e));
      }
      try {
        await api.writeTerminalInput(visibleId, "붙여넣기", false);
        paste += 1;
      } catch (e) {
        errors.push(String(e));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return {
      raw,
      paste,
      errors,
      evictionFailures: r.failures,
      requests: r.requests,
      unvisitedStarted: r.terminals
        .getState()
        .instances.some((t) => t.id === `terminal-${r.unvisited.panes[0].id}`),
    };
  }, setup);
  console.log(JSON.stringify({ instance, ...result }, null, 2));
  assert(result.evictionFailures.length >= 2, "did not induce repeated eviction failure");
  assert.equal(result.errors.length, 0, "unrelated input was rejected");
  assert(result.raw >= 20 && result.paste >= 20, "insufficient input samples");
  assert.equal(result.unvisitedStarted, false);
  assert(
    result.requests.every(
      (request) => request.terminalIds?.length === 1 && request.terminalIds[0] === setup.hiddenId,
    ),
    "unvisited pane entered eviction",
  );
} finally {
  await page.evaluate(() => {
    const r = window.__evictionRepro;
    if (!r) return;
    r.inject = false;
    r.settings.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
  });
  await browser.close();
}
