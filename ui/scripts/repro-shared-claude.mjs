/* global window, fetch */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1");
const mode = process.argv[2] ?? "setup";
const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.gitCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
);
assert.equal(
  health.instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const fixturePath =
  `${process.cwd().replaceAll("\\", "/")}/scripts/fixtures/shared-claude.py`.replace(
    /^([A-Za-z]):/,
    (_, drive) => `/mnt/${drive.toLowerCase()}`,
  );
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:1420"));
  assert(page);
  const result = await page.evaluate(
    async ({ mode, fixturePath }) => {
      const api = await import("/src/lib/tauri-api.ts");
      const { useWorkspaceStore: ws } = await import("/src/stores/workspace-store.ts");
      const { useTerminalStore: terminals } = await import("/src/stores/terminal-store.ts");
      const { useSettingsStore: settings } = await import("/src/stores/settings-store.ts");
      const { makeSlot } = await import("/src/lib/pane-layers.ts");
      const persist = await import("/src/lib/persist-session.ts");
      const ids = ["shared-claude-a", "shared-claude-b"];
      const terminalIds = ids.map((id) => `terminal-${id}`);
      if (mode === "setup") {
        settings.setState({ exit: { ...settings.getState().exit, interruptTerminals: false } });
        ws.setState({
          workspaces: [
            ...ws.getState().workspaces.filter((w) => !ids.includes(w.id)),
            ...ids.map((id) => ({
              id,
              name: id,
              panes: [
                makeSlot(id, { x: 0, y: 0, w: 1, h: 1 }, { type: "TerminalView", profile: "WSL" }),
              ],
            })),
          ],
        });
        for (const id of ids) {
          await api.createTerminalSession(`terminal-${id}`, "WSL", 100, 30, id, false, false);
          await api.writeToTerminal(
            `terminal-${id}`,
            `HOME=/tmp/laymux-shared-claude-fixture python3 '${fixturePath.replaceAll("'", "'\\''")}' shared-claude-session ${id.endsWith("a") ? "busy" : "idle"}\r`,
          );
        }
        for (let attempt = 0; attempt < 30; attempt++) {
          const outputs = await Promise.all(
            terminalIds.map(
              async (id) =>
                await (await fetch(`http://127.0.0.1:19281/api/v1/terminals/${id}/output`)).text(),
            ),
          );
          if (outputs.every((output) => /SHARED_CLAUDE_READY \d/.test(output))) break;
          if (attempt === 29) throw new Error("fixture 시작 실패");
          await new Promise((r) => window.setTimeout(r, 500));
        }
        await persist.flushSessionCheckpoint();
      }
      if (mode === "reattach" || mode === "visit") {
        for (const id of ids.filter((id) => mode !== "visit" || id !== ids[0]))
          await api.createTerminalSession(`terminal-${id}`, "WSL", 100, 30, id, false, false);
      }
      if (mode === "visit") {
        ws.setState({ activeWorkspaceId: ids[0] });
        await new Promise((r) => window.setTimeout(r, 2000));
      }
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const attributions = await api.getTerminalSessionAttributions();
        let error;
        try {
          await persist.flushSessionCheckpoint({ reason: "close", requireConclusive: true });
        } catch (e) {
          error = String(e);
        }
        samples.push({
          attributions: Object.fromEntries(terminalIds.map((id) => [id, attributions[id]])),
          error,
        });
      }
      let closeError;
      if (mode !== "startup" && mode !== "visit")
        try {
          await persist.saveBeforeClose();
        } catch (e) {
          closeError = String(e);
        }
      const saved = await api.loadSettings();
      return {
        samples,
        closeError,
        states: await api.getAgentSessionStates(terminalIds, [], terminalIds),
        transcriptBaselines: await api.beginClaudeTurns(
          terminalIds.map((terminalId) => ({ terminalId, key: "shared-transcript-probe" })),
        ),
        neverVisited: ids.every((id) => ws.getState().activeWorkspaceId !== id),
        rendererless: terminalIds.every(
          (id) => !terminals.getState().instances.some((t) => t.id === id),
        ),
        saved: saved.workspaces.filter((w) => ids.includes(w.id)),
      };
    },
    { mode, fixturePath },
  );
  console.log(JSON.stringify({ instance: health.instance, ...result }, null, 2));
  if (mode !== "visit") assert(result.neverVisited && result.rendererless);
  const expected = process.env.LAYMUX_EXPECT_FIXED === "1";
  for (const sample of result.samples) {
    if (mode === "startup") {
      assert(Object.values(sample.attributions).every((value) => value === undefined));
      assert.equal(sample.error, undefined);
      continue;
    }
    for (const verdict of Object.values(sample.attributions)) {
      assert.equal(verdict.state, expected ? "identified" : "activeButUnidentified");
    }
    assert.equal(Boolean(sample.error), !expected);
  }
  assert.equal(Boolean(result.closeError), !expected);
  if (expected) {
    assert.deepEqual(result.transcriptBaselines, []);
    if (mode !== "startup") {
      assert.equal(result.states["terminal-shared-claude-a"].status, "running");
      assert.equal(result.states["terminal-shared-claude-b"].status, "idle");
      for (const state of Object.values(result.states))
        assert.equal(state.submittedInput, undefined);
    }
    assert.equal(result.saved.length, 2);
    for (const workspace of result.saved)
      assert.equal(workspace.panes[0].view.lastClaudeSession, "shared-claude-session");
  }
} finally {
  await browser.close();
}
