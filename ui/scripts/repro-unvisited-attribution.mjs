/* global window, fetch */
// Isolated dev profile only. Creates an unvisited workspace, then a rendererless
// WSL PTY with a fake Codex process (no conversation or provider network calls).
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1", "Use an isolated dev APPDATA profile");
const fixturePath = `${process.cwd().replaceAll("\\", "/")}/scripts/fixtures/idle-codex.py`.replace(
  /^([A-Za-z]):/,
  (_, drive) => `/mnt/${drive.toLowerCase()}`,
);
const health = await (await fetch("http://127.0.0.1:19281/api/v1/health")).json();
const instance = health.instance ?? health.data?.instance;
assert.equal(instance?.buildKind, "dev");
assert.equal(
  instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith("http://localhost:1420"));
assert(page);
try {
  const result = await page.evaluate(async (fixturePath) => {
    const api = await import("/src/lib/tauri-api.ts");
    const { useSettingsStore: settings } = await import("/src/stores/settings-store.ts");
    const { useWorkspaceStore: ws } = await import("/src/stores/workspace-store.ts");
    const { useTerminalStore: terminals } = await import("/src/stores/terminal-store.ts");
    const { flushSessionCheckpoint } = await import("/src/lib/persist-session.ts");
    const suffix = Date.now().toString(36);
    const workspaceId = `repro-unvisited-${suffix}`;
    const paneId = `repro-unvisited-pane-${suffix}`;
    const id = `terminal-${paneId}`;
    const command = `python3 ${fixturePath}`;
    settings.setState({ codex: { ...settings.getState().codex, command } });
    ws.setState({
      workspaces: [
        ...ws.getState().workspaces,
        {
          id: workspaceId,
          name: "Unvisited attribution repro",
          panes: [
            {
              id: paneId,
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: {
                type: "TerminalView",
                profile: "WSL",
                lastCodexSession: "saved-unvisited-session",
              },
            },
          ],
        },
      ],
    });
    const notStarted = await flushSessionCheckpoint({ reason: "update", requireConclusive: true });
    const unmountedBefore = !terminals.getState().instances.some((t) => t.id === id);
    try {
      await api.createTerminalSession(
        id,
        "WSL",
        80,
        24,
        workspaceId,
        false,
        false,
        undefined,
        `${command} resume saved-unvisited-session`,
      );
      // Deliberately exceed the old frontend startup grace, without focusing.
      await new Promise((resolve) => window.setTimeout(resolve, 17000));
      const output = await (
        await fetch(`http://127.0.0.1:19281/api/v1/terminals/${id}/output`)
      ).text();
      if (!output.includes("IDLE_CODEX_RESTORE_READY"))
        throw new Error(`fixture did not start: ${output}`);
      const attributions = await api.getTerminalSessionAttributions();
      const restored = await flushSessionCheckpoint({ reason: "update", requireConclusive: true });
      const saved = await api.loadSettings();
      const savedId = saved.workspaces.find((w) => w.id === workspaceId)?.panes[0].view
        .lastCodexSession;
      await api.writeTerminalProtocolReply(id, attributions[id].generation, "\x1b[0n");
      const afterProtocol = (await api.getTerminalSessionAttributions())[id];
      await api.writeToTerminal(id, "new work\r");
      const afterInput = (await api.getTerminalSessionAttributions())[id];
      let updateError;
      try {
        await flushSessionCheckpoint({ reason: "update", requireConclusive: true });
      } catch (error) {
        updateError = String(error);
      }
      return {
        id,
        unmountedBefore,
        neverFocused: ws.getState().activeWorkspaceId !== workspaceId,
        noPtyCovered: notStarted.coverage.some((t) => t.terminalId === id),
        attribution: attributions[id],
        restored: restored.coverage.find((t) => t.terminalId === id),
        savedId,
        afterProtocol,
        afterInput,
        updateError,
      };
    } finally {
      await api.closeTerminalSession(id);
    }
  }, fixturePath);
  console.log(JSON.stringify({ instance, ...result }, null, 2));
  assert(result.unmountedBefore && result.neverFocused);
  assert.equal(result.noPtyCovered, false);
  assert.equal(result.attribution.state, "restorePending");
  assert.equal(result.savedId, "saved-unvisited-session");
  assert.equal(result.restored.sessionId, "saved-unvisited-session");
  assert.equal(result.afterProtocol.state, "restorePending");
  assert.equal(result.afterInput.state, "activeButUnidentified");
  assert(
    result.updateError.includes(
      `Session attribution is not conclusive for ${result.id}: activeButUnidentified`,
    ),
  );
} finally {
  await browser.close();
}
