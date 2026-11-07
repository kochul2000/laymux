// Windows dev-only: actual /mo and /cl + Tab + Enter, without model preference changes.
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:19281/api/v1";
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
const browser = await chromium.connectOverCDP(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9347",
);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((p) =>
    p.url().startsWith(process.env.LAYMUX_DEV_URL || "http://localhost:1420/"),
  );
assert.ok(page);
const original = (await api("/workspaces", undefined, "GET")).activeWorkspaceId;
let workspaceId;
try {
  workspaceId = (
    await api("/workspaces", { name: "Claude slash Tab regression" })
  ).workspace.id;
  await api("/workspaces/active", { id: workspaceId });
  await api(
    "/panes/0/view",
    { type: "TerminalView", profile: "PowerShell" },
    "PUT",
  );
  const terminalId = (
    await api("/workspaces", undefined, "GET")
  ).workspaces.find((w) => w.id === workspaceId).panes[0].terminalId;
  const editor = page
    .getByTestId("terminal-view-" + terminalId)
    .locator("textarea.xterm-helper-textarea");
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.type(`claude --session-id ${randomUUID()}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(10000);
  const waitComposer = () =>
    page.waitForFunction(
      async (id) => {
        const { getTerminalInspector } =
          await import("/src/lib/terminal-serialize-registry.ts");
        const { agentClearComposer } =
          await import("/src/lib/agent-clear-composer.ts");
        const s = getTerminalInspector(id)?.(0);
        return s && agentClearComposer(s, "Claude") === "empty";
      },
      terminalId,
      { timeout: 60000 },
    );
  await waitComposer();
  const boundary = () =>
    page.evaluate(async (id) => {
      const { useTerminalStore } =
        await import("/src/stores/terminal-store.ts");
      const i = useTerminalStore.getState().instances.find((i) => i.id === id);
      return {
        submission: i.lastInputSubmissionAt ?? 0,
        cleared: i.lastInputClearedAt ?? 0,
      };
    }, terminalId);
  const waitInput = (expected, before) =>
    page.waitForFunction(
      async ({ id, expected, before }) => {
        const { useTerminalStore } =
          await import("/src/stores/terminal-store.ts");
        const { selectTerminalLastInput } =
          await import("/src/lib/terminal-last-input.ts");
        const i = useTerminalStore
          .getState()
          .instances.find((i) => i.id === id);
        return (
          i &&
          (expected === null
            ? !selectTerminalLastInput(i) &&
              i.lastInputClearedAt > before.cleared
            : selectTerminalLastInput(i) === expected &&
              i.lastInputSubmissionAt > before.submission)
        );
      },
      { id: terminalId, expected, before },
      { timeout: 5000 },
    );
  const proof = {};
  for (const delay of [500, 0]) {
    const before = await boundary();
    await editor.focus();
    await page.keyboard.type("/mo");
    await page.keyboard.press("Tab");
    if (delay) await page.waitForTimeout(delay);
    await page.keyboard.press("Enter");
    await waitInput("/model", before);
    const record = await page.evaluate(async (id) => {
      const { getAgentSessionStates } = await import("/src/lib/tauri-api.ts");
      return (await getAgentSessionStates([id], [], [id]))[id];
    }, terminalId);
    assert.notEqual(
      record?.submittedInput?.text,
      "/model",
      "proof must precede the deferred transcript record",
    );
    if (delay) {
      await page.waitForTimeout(16000);
      await waitInput("/model", before);
      await page
        .getByTestId("pane-last-input-" + terminalId)
        .scrollIntoViewIfNeeded();
      proof.modelScreenshot = (await api("/screenshot", {})).path;
    }
    proof[delay ? "modelTab" : "fastModelTab"] = true;
    await page.keyboard.press("Escape");
    await waitComposer();
    // Reset any input-side standalone Escape before the next independent case.
    await page.keyboard.press("Control+u");
  }
  for (const delay of [500, 0]) {
    const before = await boundary();
    await page.keyboard.type("/cl");
    await page.keyboard.press("Tab");
    if (delay) await page.waitForTimeout(delay);
    await page.keyboard.press("Enter");
    await waitInput(null, before);
    await waitComposer();
    proof[delay ? "clearTab" : "fastClearTab"] = true;
  }
  proof.clearScreenshot = (await api("/screenshot", {})).path;
  console.log(JSON.stringify(proof));
} finally {
  if (original) await api("/workspaces/active", { id: original });
  if (workspaceId) await api(`/workspaces/${workspaceId}`, undefined, "DELETE");
  await browser.close();
}
