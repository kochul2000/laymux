/* global fetch, window, setTimeout, performance */
// Run against an isolated dev profile and WebView2 CDP port 9229 only.
// Injects attribution failures in the WebView IPC adapter; production Rust
// eviction, human input, and PTY writers remain real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1", "격리된 dev APPDATA가 필요합니다");
const base = "http://127.0.0.1:19281";
const token = randomUUID();
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
    r.inFlight += 1;
    try { return await realInvoke(command, args, options); }
    catch(error) { r.failures.push(String(error)); throw error; }
    finally { r.inFlight -= 1; }
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
    const { makeSlot } = await import("/src/lib/pane-layers.ts");
    const profile = settings.getState().profiles.find((p) => /powershell/i.test(p.name));
    if (!profile) throw new Error("PowerShell profile required");
    const suffix = Date.now().toString(36);
    const make = (kind) => ({
      id: `repro-${kind}-${suffix}`,
      name: `Repro-${kind}`,
      panes: [
        makeSlot(
          `repro-${kind}-pane-${suffix}`,
          { x: 0, y: 0, w: 12, h: 12 },
          {
            type: "TerminalView",
            profile: profile.name,
            inputMode: "direct",
            ...(kind === "unvisited" ? { lastCodexSession: "saved-unvisited-repro" } : {}),
          },
        ),
      ],
    });
    const visible = make("visible"),
      hidden = make("hidden"),
      unvisited = make("unvisited");
    visible.panes[0].w = 6;
    visible.panes.push(
      makeSlot(
        `${visible.panes[0].id}-second`,
        { x: 6, y: 0, w: 6, h: 12 },
        { ...visible.panes[0].layers[0].view },
      ),
    );
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
      inFlight: 0,
      inject: false,
    };
    return {
      hiddenId: `terminal-${hidden.panes[0].id}`,
      visibleId: `terminal-${visible.panes[0].id}`,
      secondId: `terminal-${visible.panes[1].id}`,
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
    setup.secondId,
    { timeout: 30_000 },
  );
  await page.evaluate(async (token) => {
    const api = await import("/src/lib/tauri-api.ts");
    await api.setRemoteRuntimeAccess(true, token);
  }, token);
  const remotePost = async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const claim = await remotePost("/remote/v1/session/claim", { clientName: "eviction-repro" });
  assert.equal(claim.status, 200, "Remote 제어권 획득 실패");
  const leaseId = claim.data.leaseId;
  assert(leaseId);
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
  const inputRun = page.evaluate(
    async ({ visibleId, leaseId }) => {
      const r = window.__evictionRepro;
      const api = await import("/src/lib/tauri-api.ts");
      const errors = [];
      let raw = 0,
        paste = 0;
      const started = performance.now();
      while (performance.now() - started < 25_000) {
        try {
          await api.writeToTerminalForRemote(visibleId, "a", leaseId);
          raw += 1;
        } catch (e) {
          errors.push(String(e));
        }
        try {
          await api.writeTerminalInputForRemote(visibleId, "붙여넣기", false, leaseId);
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
    },
    { ...setup, leaseId },
  );
  const navigationRun = (async () => {
    const errors = [];
    let switches = 0,
      duringEviction = 0;
    const started = performance.now();
    while (performance.now() - started < 25_000) {
      const busy = await page.evaluate(() => window.__evictionRepro.inFlight > 0);
      const id = switches % 2 ? setup.visibleId : setup.secondId;
      const response = await remotePost(`/remote/v1/terminals/${encodeURIComponent(id)}/focus`, {
        leaseId,
      });
      if (response.status !== 200 || response.data.focused !== id) errors.push(response);
      else if (busy) duringEviction += 1;
      switches += 1;
      await remotePost("/remote/v1/session/heartbeat", { leaseId });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { errors, switches, duringEviction };
  })();
  const [result, navigation] = await Promise.all([inputRun, navigationRun]);
  console.log(JSON.stringify({ instance, ...result, navigation }, null, 2));
  assert.equal(navigation.errors.length, 0, "정상 pane의 Remote 전환이 거부됨");
  assert(navigation.duringEviction >= 10, "회수 중 탐색 표본 부족");
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
  await page.evaluate(async () => {
    const r = window.__evictionRepro;
    if (!r) return;
    r.inject = false;
    r.settings.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
    const api = await import("/src/lib/tauri-api.ts");
    await api.setRemoteRuntimeAccess(false);
  });
  await browser.close();
}
