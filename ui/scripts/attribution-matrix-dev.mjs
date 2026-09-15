/* global fetch, performance */
// Run from ui, against an isolated dev profile. JSON actions make every mutation
// and observation reproducible without adding a production test endpoint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1");
const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
const instance = health.instance ?? health.data?.instance;
assert.equal(instance.buildKind, "dev");
assert.equal(
  instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
);
const action = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:1420"));
  assert(page);
  const result = await page.evaluate(async (action) => {
    const api = await import("/src/lib/tauri-api.ts");
    const { useWorkspaceStore: ws } = await import("/src/stores/workspace-store.ts");
    const { useSettingsStore: settings } = await import("/src/stores/settings-store.ts");
    const { useTerminalStore: terminals } = await import("/src/stores/terminal-store.ts");
    const { flushSessionCheckpoint } = await import("/src/lib/persist-session.ts");
    if (action.type === "setup") {
      assertPrefix(action.workspace);
      const columns = Math.ceil(Math.sqrt(action.panes.length));
      const rows = Math.ceil(action.panes.length / columns);
      const panes = action.panes.map((p, i) => ({
        id: p.id,
        x: (i % columns) / columns,
        y: Math.floor(i / columns) / rows,
        w: 1 / columns,
        h: 1 / rows,
        view: {
          type: "TerminalView",
          profile: p.profile,
          cwdSend: false,
          cwdReceive: false,
          lastCwd: p.cwd,
          ...p.view,
        },
      }));
      ws.setState({
        workspaces: [
          ...ws.getState().workspaces.filter((w) => w.id !== action.workspace),
          { id: action.workspace, name: action.workspace, panes },
        ],
        ...(action.activate ? { activeWorkspaceId: action.workspace } : {}),
      });
      if (action.rendererless) {
        for (const p of panes)
          await api.createTerminalSession(
            `terminal-${p.id}`,
            p.view.profile,
            100,
            30,
            action.workspace,
            false,
            false,
            p.view.lastCwd,
          );
      }
      return { workspace: action.workspace };
    }
    if (action.type === "settings") {
      settings.setState(action.values);
      await flushSessionCheckpoint();
      return { saved: true };
    }
    if (action.type === "switch") {
      assertPrefix(action.workspace);
      ws.setState({ activeWorkspaceId: action.workspace });
      return { workspace: action.workspace };
    }
    if (action.type === "write") {
      for (const id of action.ids) {
        assertPrefix(id);
        await api.writeToTerminal(id, action.input);
      }
      return { sent: action.ids };
    }
    if (action.type === "close") {
      for (const id of action.ids) {
        assertPrefix(id);
        await api.closeTerminalSession(id);
      }
      return { closed: action.ids };
    }
    if (action.type === "inspect")
      return {
        workspaces: ws.getState().workspaces,
        profiles: settings.getState().profiles,
        instances: terminals
          .getState()
          .instances.map(({ terminal, ...t }) => ({ ...t, renderer: Boolean(terminal) })),
        attributions: await api.getTerminalSessionAttributions(),
      };
    const samples = [];
    for (let repetition = 0; repetition < (action.repetitions ?? 1); repetition++) {
      const started = performance.now();
      const attributions = await api.getTerminalSessionAttributions();
      let checkpoint, error;
      try {
        checkpoint = await flushSessionCheckpoint({
          reason: "update",
          requireConclusive: true,
          terminalIds: action.ids,
        });
      } catch (e) {
        error = String(e);
      }
      const saved = await api.loadSettings();
      const panes = saved.workspaces
        .flatMap((w) => w.panes)
        .filter((p) => !action.ids || action.ids.includes(`terminal-${p.id}`))
        .map((p) => ({ id: p.id, view: p.view }));
      const mismatches = [];
      for (const [id, expected] of Object.entries(action.expected ?? {})) {
        for (const [key, value] of Object.entries(expected)) {
          if (attributions[id]?.[key] !== value)
            mismatches.push(`${id}.${key}: expected ${value}, got ${attributions[id]?.[key]}`);
        }
        const coverage = checkpoint?.coverage.find((entry) => entry.terminalId === id);
        if (action.checkpoint !== "reject" && !coverage)
          mismatches.push(`No committed coverage for ${id}`);
        if (coverage && expected.sessionId && coverage.sessionId !== expected.sessionId)
          mismatches.push(`Wrong committed session for ${id}`);
        const view = panes.find((p) => `terminal-${p.id}` === id)?.view;
        if (
          !error &&
          expected.state === "fresh" &&
          (view?.lastAgentFresh !== "codex" || view?.lastCodexSession)
        )
          mismatches.push(`Wrong fresh metadata for ${id}`);
        if (
          !error &&
          expected.state === "identified" &&
          view?.lastCodexSession !== expected.sessionId
        )
          mismatches.push(`Wrong resume metadata for ${id}`);
      }
      if (action.checkpoint === "reject" ? !error : action.expected && error)
        mismatches.push(`Unexpected checkpoint outcome: ${error}`);
      samples.push({
        repetition,
        ms: Math.round(performance.now() - started),
        attributions,
        checkpoint,
        error,
        panes,
        mismatches,
      });
    }
    return samples;
    function assertPrefix(id) {
      if (!id.includes("matrix-")) throw new Error(`Not a matrix-owned target: ${id}`);
    }
  }, action);
  console.log(JSON.stringify({ instance, action, result }));
  if (Array.isArray(result) && result.some((sample) => sample.mismatches?.length))
    process.exitCode = 1;
} finally {
  await browser.close();
}
