// Windows dev-only regression: actual xterm input, PowerShell PSReadLine and Claude.
// Run from the worktree with a dev WebView exposing a CDP port. The release API is never used.
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:19281/api/v1";
const devUrl = process.env.LAYMUX_DEV_URL || "http://localhost:1447/";
const cdpUrl = process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9347";
const shellOnly = process.argv.includes("--shell-only");
async function api(route, body, method = "POST") {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const health = await api("/health", undefined, "GET");
assert.equal(health.port, 19281);
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  process.cwd().toLowerCase(),
);
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((p) => p.url().startsWith(devUrl));
assert.ok(page, "Expected this worktree's dev WebView");
const original = await page.evaluate(async () => {
  const { useWorkspaceStore } = await import("/src/stores/workspace-store.ts");
  return useWorkspaceStore.getState().activeWorkspaceId;
});
const fixture = `selector-tab-${randomUUID().slice(0, 8)}-completion-target.txt`;
const commandName = `selector-display-${randomUUID().slice(0, 8)}`;
const commandFile = path.join(".claude", "commands", `${commandName}.md`);
let workspaceId;
try {
  await fs.writeFile(fixture, "selector input completion fixture\n", {
    flag: "wx",
  });
  workspaceId = (
    await api("/workspaces", { name: "Selector input regression" })
  ).workspace.id;
  await api("/workspaces/active", { id: workspaceId });
  await api(
    "/panes/0/view",
    { type: "TerminalView", profile: "PowerShell" },
    "PUT",
  );
  const terminalId = await page.evaluate(async () => {
    const { useWorkspaceStore } =
      await import("/src/stores/workspace-store.ts");
    const store = useWorkspaceStore.getState();
    return (
      "terminal-" +
      store.workspaces.find((w) => w.id === store.activeWorkspaceId).panes[0]
        .activeLayerId
    );
  });
  await page.waitForFunction(async (id) => {
    const { useTerminalStore } = await import("/src/stores/terminal-store.ts");
    return useTerminalStore.getState().instances.find((i) => i.id === id)
      ?.sessionReady;
  }, terminalId);
  const input = page
    .getByTestId("terminal-view-" + terminalId)
    .locator("textarea.xterm-helper-textarea");
  await input.focus();
  async function submit(text) {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  }
  async function waitInput(expected) {
    await page.waitForFunction(
      async ({ id, expected }) => {
        const { useTerminalStore } =
          await import("/src/stores/terminal-store.ts");
        const { selectTerminalLastInput } =
          await import("/src/lib/terminal-last-input.ts");
        const i = useTerminalStore
          .getState()
          .instances.find((i) => i.id === id);
        const text = i && selectTerminalLastInput(i);
        return expected === null
          ? !text && i?.lastInputClearedAt > 0
          : text === expected;
      },
      { id: terminalId, expected },
    );
  }
  await submit(`Set-Location '${process.cwd().replaceAll("'", "''")}'`);
  await page.waitForTimeout(300);
  await page.keyboard.type("Get-Chil");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await waitInput("Get-ChildItem");
  await submit("Clear-Host");
  await waitInput(null);
  await submit("Write-Output previous-input");
  await waitInput("Write-Output previous-input");
  await api(`/workspaces/${workspaceId}/clear`, {});
  await waitInput(null);
  const proof = { shellTab: true, shellClear: true, workspaceClear: true };
  if (!shellOnly) {
    await fs.writeFile(
      commandFile,
      "Reply OK without using tools. $ARGUMENTS\n",
      { flag: "wx" },
    );
    await submit("claude");
    await page.waitForFunction(
      async (id) => {
        const { getTerminalInspector } =
          await import("/src/lib/terminal-serialize-registry.ts");
        const { agentClearComposer } =
          await import("/src/lib/agent-clear-composer.ts");
        const screen = getTerminalInspector(id)?.(0);
        return screen && agentClearComposer(screen, "Claude") === "empty";
      },
      terminalId,
      { timeout: 60000 },
    );
    const prefix = "Reply OK without using tools. Input display test: @";
    await page.keyboard.type(prefix + fixture.slice(0, -7));
    await page.waitForTimeout(800);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await waitInput(prefix + fixture);
    const waitForIdle = async () => {
      let idleSince;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const idle = await page.evaluate(async (id) => {
          const { useTerminalStore } =
            await import("/src/stores/terminal-store.ts");
          const { terminalTaskPolicy } =
            await import("/src/lib/terminal-task.ts");
          const { getTerminalInspector } =
            await import("/src/lib/terminal-serialize-registry.ts");
          const { agentClearComposer } =
            await import("/src/lib/agent-clear-composer.ts");
          const instance = useTerminalStore
            .getState()
            .instances.find((i) => i.id === id);
          const screen = getTerminalInspector(id)?.(0);
          return (
            instance &&
            terminalTaskPolicy(instance).clearAllowed &&
            screen &&
            agentClearComposer(screen, "Claude") === "empty"
          );
        }, terminalId);
        if (idle) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= 1000) return;
        } else idleSince = undefined;
        await page.waitForTimeout(200);
      }
      assert.fail("Claude did not reach a stable idle composer");
    };
    await waitForIdle();
    await submit(`/${commandName} display-args`);
    await page.waitForFunction(
      async ({ id, command }) => {
        const { getAgentSessionStates } = await import("/src/lib/tauri-api.ts");
        const records = await getAgentSessionStates([id], [], [id]);
        return records[id]?.submittedInput?.text === command;
      },
      { id: terminalId, command: `/${commandName} display-args` },
      { timeout: 30000 },
    );
    // Force the correction path to prove that the transcript never injects its XML envelope.
    await page.evaluate(async (id) => {
      const { useTerminalStore } =
        await import("/src/stores/terminal-store.ts");
      useTerminalStore.getState().updateInstanceInfo(id, {
        lastUserInput: "incomplete key reconstruction",
      });
    }, terminalId);
    await waitInput(`/${commandName} display-args`);
    await waitForIdle();
    proof.claudeSlashCommand = true;
    await page
      .getByText(`/${commandName} display-args`, { exact: true })
      .scrollIntoViewIfNeeded();
    proof.claudeSlashScreenshot = (await api("/screenshot", {})).path;
    const retainedDraft = "Reply OK without using tools. Retained draft";
    await page.keyboard.type(retainedDraft);
    await page.keyboard.press("Control+l");
    await page.waitForTimeout(300);
    const keptDraft = await page.evaluate(
      async ({ id, text }) => {
        const { getTerminalInspector } =
          await import("/src/lib/terminal-serialize-registry.ts");
        return getTerminalInspector(id)?.(0).lines.some((line) =>
          line.text.includes(text),
        );
      },
      { id: terminalId, text: retainedDraft },
    );
    assert.ok(keptDraft, "screen clear must retain the app's draft");
    await submit(" suffix");
    await waitInput(retainedDraft + " suffix");
    await waitForIdle();
    await page.evaluate(async (id) => {
      const { clearTerminalInputHistory } =
        await import("/src/lib/terminal-input-history.ts");
      clearTerminalInputHistory(id);
    }, terminalId);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    // Current Claude accepts its history preview into the editor before submitting it.
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await waitInput(retainedDraft + " suffix");
    await waitForIdle();
    const cleared = await api(
      `/panes/${terminalId.replace(/^terminal-/, "")}/clear`,
      {},
    );
    assert.deepEqual(cleared.cleared, [terminalId], JSON.stringify(cleared));
    await waitInput(null);
    await page.waitForTimeout(1500);
    await waitInput(null);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    await waitInput(null);
    Object.assign(proof, {
      claudeTab: true,
      claudeClear: true,
      retainedDraft: true,
      recalledInput: true,
      emptyEnter: true,
    });
  }
  const screenshot = await api("/screenshot", {});
  console.log(JSON.stringify({ ...proof, screenshot: screenshot.path }));
} finally {
  if (original) await api("/workspaces/active", { id: original });
  if (workspaceId) await api(`/workspaces/${workspaceId}`, undefined, "DELETE");
  await fs.unlink(fixture);
  if (!shellOnly) await fs.rm(commandFile, { force: true });
  await browser.close();
}
