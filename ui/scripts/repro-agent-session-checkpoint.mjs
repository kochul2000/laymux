/* global fetch */
// Dev-only, real CLI repro. Each command explicitly targets the isolated panes.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:19281";
assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1", "Use an isolated dev APPDATA profile");
const health = await (await fetch(`${base}/api/v1/health`)).json();
const instance = health.instance ?? health.data?.instance;
assert.equal(instance?.buildKind, "dev");
assert.equal(
  instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  process.cwd().replaceAll("\\", "/").replace(/\/ui$/, "").toLowerCase(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://localhost:1420"));
  assert(page);
  const [action = "sample", provider, input] = process.argv.slice(2);
  const native = process.env.LAYMUX_REPRO_NATIVE === "1";
  if (action === "setup" && native) {
    assert(process.env.LAYMUX_REPRO_CWD, "Set an isolated native test working directory");
  }
  const result = await page.evaluate(
    async ({ action, provider, input, native, cwd }) => {
      const api = await import("/src/lib/tauri-api.ts");
      const { useWorkspaceStore: ws } = await import("/src/stores/workspace-store.ts");
      const providers = ["claude", "codex", "grok"];
      if (action === "setup") {
        const id = "ws-empty-agent-repro";
        if (!ws.getState().workspaces.some((w) => w.id === id)) {
          ws.setState({
            workspaces: [
              ...ws.getState().workspaces,
              {
                id,
                name: "Empty-agent-repro",
                panes: providers.map((name, i) => ({
                  id: `pane-empty-repro-${name}`,
                  x: i / 3,
                  y: 0,
                  w: 1 / 3,
                  h: 1,
                  view: {
                    type: "TerminalView",
                    profile: native ? "PowerShell" : "WSL",
                    cwdSend: false,
                    cwdReceive: false,
                    lastCwd: cwd,
                  },
                })),
              },
            ],
            activeWorkspaceId: id,
          });
        }
        return { workspace: id };
      }
      if (action === "write") {
        if (!providers.includes(provider)) throw new Error("Unknown repro provider");
        await api.writeToTerminal(`terminal-pane-empty-repro-${provider}`, input);
        return { provider, sent: true };
      }
      const attributions = await api.getTerminalSessionAttributions();
      const { flushSessionCheckpoint } = await import("/src/lib/persist-session.ts");
      const results = {};
      for (const name of providers) {
        const id = `terminal-pane-empty-repro-${name}`;
        let checkpoint;
        try {
          const commit = await flushSessionCheckpoint({
            reason: "update",
            requireConclusive: true,
            terminalIds: [id],
          });
          checkpoint = commit.coverage.find((entry) => entry.terminalId === id);
        } catch (error) {
          checkpoint = String(error);
        }
        results[name] = { attribution: attributions[id], checkpoint };
      }
      return results;
    },
    { action, provider, input, native, cwd: process.env.LAYMUX_REPRO_CWD ?? "/tmp" },
  );
  if (action === "setup") {
    await page.waitForFunction(async () => {
      const { useTerminalStore } = await import("/src/stores/terminal-store.ts");
      return ["claude", "codex", "grok"].every((provider) =>
        useTerminalStore.getState().instances.some(
          (instance) => instance.id === `terminal-pane-empty-repro-${provider}` && instance.sessionReady,
        ),
      );
    });
  }
  console.log(JSON.stringify({ instance, result }, null, 2));
} finally {
  await browser.close();
}
