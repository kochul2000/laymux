// 현재 워크트리의 dev에서 실행: node scripts/tests/mcp-pane-focus.e2e.mjs
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339 필요.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const base = "http://127.0.0.1:19281";
const devUrl = process.env.LAYMUX_DEV_URL ?? "http://localhost:1420/";
const normalize = (value) => path.resolve(value).toLowerCase();
const health = await (await fetch(`${base}/api/v1/health`)).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(normalize(health.instance.worktreeRoot), normalize(repo));
assert.equal(
  health.instance.gitCommit,
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
);
const browser = await chromium.connectOverCDP(
  process.env.LAYMUX_FOCUS_CDP ?? "http://127.0.0.1:9339",
);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url() === devUrl);
assert.ok(page, "현재 워크트리의 dev WebView가 필요합니다.");
const artifacts = path.join(repo, ".screenshots", "mcp-pane-focus");
await mkdir(artifacts, { recursive: true });

let session;
let requestId = 0;
async function rpc(method, params, expectedErrorCode) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `MCP HTTP ${response.status}`);
  session = response.headers.get("mcp-session-id") ?? session;
  const raw = await response.text();
  // rmcp의 빈 SSE priming event는 JSON 응답이 아니다.
  const payload = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? raw
        .split("\n")
        .find(
          (line) =>
            line.startsWith("data:") && line.slice(5).trim().startsWith("{"),
        )
        ?.slice(5)
    : raw;
  assert.ok(payload, "MCP JSON 응답이 필요합니다.");
  const message = JSON.parse(payload);
  if (expectedErrorCode !== undefined) {
    assert.equal(
      message.error?.code,
      expectedErrorCode,
      JSON.stringify(message),
    );
    return message.error;
  }
  assert.ok(!message.error, JSON.stringify(message.error));
  return message.result;
}
async function tool(name, args = {}, expectError = false) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.equal(result.isError === true, expectError, JSON.stringify(result));
  const text = result.content.find((item) => item.type === "text").text;
  return expectError ? text : JSON.parse(text);
}
async function restActivate(body, expectError = false, expectedStatus) {
  const response = await fetch(`${base}/api/v1/panes/layers/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { error: raw };
  }
  if (expectedStatus !== undefined)
    assert.equal(response.status, expectedStatus, raw);
  assert.equal(
    !response.ok || result.success === false,
    expectError,
    JSON.stringify(result),
  );
  return result;
}
async function snapshot() {
  return page.evaluate(async () => {
    const { useWorkspaceStore } =
      await import("/src/stores/workspace-store.ts");
    const { useGridStore } = await import("/src/stores/grid-store.ts");
    const { useDockStore } = await import("/src/stores/dock-store.ts");
    const workspace = useWorkspaceStore.getState().getActiveWorkspace();
    const grid = useGridStore.getState().focusedPaneIndex;
    const dock = useDockStore.getState();
    return {
      workspaceId: workspace.id,
      gridLayer: grid === null ? null : workspace.panes[grid]?.activeLayerId,
      dock: dock.focusedDock,
      dockPane: dock.focusedDockPaneId,
      domLayer: document.activeElement
        ?.closest("[data-layer-id]")
        ?.getAttribute("data-layer-id"),
      domTestId: document.activeElement
        ?.closest("[data-testid]")
        ?.getAttribute("data-testid"),
      tag: document.activeElement?.tagName,
    };
  });
}
const checkpoints = [];
async function unchanged(label, expected) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const actual = await snapshot();
  assert.deepEqual(actual, expected, label);
  const focusEvents = await page.evaluate(() => window.__mcpFocusEvents);
  assert.deepEqual(
    focusEvents,
    [],
    `${label}: 일시적 DOM 포커스 전환도 없어야 합니다.`,
  );
  checkpoints.push({ label, ...actual });
}
async function seedTerminal(workspaceId, profile) {
  // 테스트 준비만 수행한다. 비활성 workspace를 임시로 활성화하지 않는다.
  return page.evaluate(
    async ({ workspaceId, profile }) => {
      const { useWorkspaceStore } =
        await import("/src/stores/workspace-store.ts");
      useWorkspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id !== workspaceId
            ? ws
            : {
                ...ws,
                panes: ws.panes.map((slot) => ({
                  ...slot,
                  layers: slot.layers.map((layer) => ({
                    ...layer,
                    view: { type: "TerminalView", profile },
                  })),
                })),
              },
        ),
      }));
      return `terminal-${useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId).panes[0].layers[0].id}`;
    },
    { workspaceId, profile },
  );
}

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "mcp-pane-focus-e2e", version: "1" },
});
await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Session-Id": session,
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
const original = await snapshot();
const originalGrid = await tool("get_grid_state");
const createdIds = [];
let focusListenerInstalled = false;
try {
  const activationTool = (await rpc("tools/list", {})).tools.find(
    (item) => item.name === "activate_pane_layer",
  );
  assert.ok(activationTool);
  assert.ok(!Object.hasOwn(activationTool.inputSchema.properties, "focus"));
  assert.equal(activationTool.inputSchema.additionalProperties, false);
  const { workspace } = await tool("create_workspace", {
    name: "MCP focus verification",
  });
  createdIds.push(workspace.id);
  const profile = await page.evaluate(async () => {
    const state = (
      await import("/src/stores/settings-store.ts")
    ).useSettingsStore.getState();
    return (
      state.profiles.find((item) =>
        /^(?:powershell|pwsh)(?:\.exe)?\b/i.test(item.commandLine),
      )?.name ?? state.defaultProfile
    );
  });
  const ownerId = await seedTerminal(workspace.id, profile);
  await tool("focus_terminal", { terminal_id: ownerId });
  await page.waitForFunction(
    (id) =>
      document.activeElement
        ?.closest("[data-layer-id]")
        ?.getAttribute("data-layer-id") === id,
    ownerId.replace(/^terminal-/, ""),
  );
  await page.evaluate(() => {
    window.__mcpFocusEvents = [];
    window.__mcpFocusListener = (event) =>
      window.__mcpFocusEvents.push({
        type: event.type,
        layer: event.target.closest("[data-layer-id]")?.dataset.layerId,
      });
    document.addEventListener("focusin", window.__mcpFocusListener, true);
    document.addEventListener("focusout", window.__mcpFocusListener, true);
  });
  focusListenerInstalled = true;
  const owner = await snapshot();
  const { newPane: other } = await tool("split_pane", {
    pane_index: 0,
    direction: "vertical",
    profile,
  });
  await unchanged("split", owner);
  await tool("write_to_terminal", {
    terminal_id: other.terminalId,
    data: "echo MCP_BACKGROUND_OUTPUT",
  });
  await unchanged("write before terminal readiness", owner);
  await tool("read_terminal_output", {
    terminal_id: other.terminalId,
    lines: 10,
  });
  await unchanged("read", owner);
  const background = await tool("create_workspace", {
    name: "MCP background verification",
  });
  createdIds.push(background.workspace.id);
  const backgroundId = await seedTerminal(background.workspace.id, profile);
  await tool("write_to_terminal", {
    terminal_id: backgroundId,
    data: "echo MCP_BACKGROUND_WORKSPACE",
  });
  await tool("activate_pane_layer", { terminal_id: backgroundId });
  await unchanged("unvisited workspace startup and display", owner);
  const { newPane: hidden } = await tool("stack_pane", {
    pane_index: 0,
    profile,
  });
  await tool("write_to_terminal", {
    terminal_id: hidden.terminalId,
    data: "echo MCP_HIDDEN_OUTPUT",
  });
  await unchanged("stack and hidden-layer write", owner);
  assert.match(
    await tool("activate_pane_layer", { layer_id: hidden.id }, true),
    /focus/,
  );
  for (const focus of [true, false, null, "false"]) {
    const error = await rpc(
      "tools/call",
      {
        name: "activate_pane_layer",
        arguments: { layer_id: hidden.id, focus },
      },
      -32602,
    );
    assert.match(error.message, /focus/);
    await restActivate({ layerId: hidden.id, focus }, true, 422);
  }
  await unchanged("removed focus argument rejected by MCP and REST", owner);
  await restActivate({ layerId: hidden.id }, true);
  await unchanged("focused input layer replacement rejected", owner);
  await tool("activate_pane_layer", { terminal_id: ownerId });
  await unchanged("already shown input layer", owner);
  const { newPane: otherLayer } = await tool("stack_pane", {
    pane_index: 1,
    profile,
  });
  await tool("activate_pane_layer", { layer_id: otherLayer.id });
  await unchanged("MCP display never moves focus", owner);
  await restActivate({ layerId: other.id });
  await unchanged("REST display never moves focus", owner);
  // 실제 키보드 입력이 현재 입력 대상에만 도달하는지 검증한다.
  const marker = `HUMAN_FOCUS_${Date.now()}`;
  await page.keyboard.type(marker);
  await page.waitForFunction(
    async ({ ownerId, marker }) => {
      const { getTerminalInspector } =
        await import("/src/lib/terminal-serialize-registry.ts");
      const inspect = getTerminalInspector(ownerId);
      return inspect && JSON.stringify(inspect(100)).includes(marker);
    },
    { ownerId, marker },
  );
  assert.ok(
    !(
      await tool("read_terminal_output", {
        terminal_id: other.terminalId,
        lines: 20,
      })
    ).output.includes(marker),
  );
  await unchanged("human typing remains on the original terminal", owner);
  await page.screenshot({ path: path.join(artifacts, "preserved.png") });
  await tool("focus_terminal", { terminal_id: hidden.terminalId });
  await page.waitForFunction(
    (id) =>
      document.activeElement
        ?.closest("[data-layer-id]")
        ?.getAttribute("data-layer-id") === id,
    hidden.id,
  );
  assert.equal((await snapshot()).gridLayer, hidden.id);
  const focusResponse = await fetch(
    `${base}/api/v1/terminals/${ownerId}/focus`,
    { method: "POST" },
  );
  assert.ok(focusResponse.ok, await focusResponse.text());
  await page.waitForFunction(
    (id) =>
      document.activeElement
        ?.closest("[data-layer-id]")
        ?.getAttribute("data-layer-id") === id,
    ownerId.replace(/^terminal-/, ""),
  );
  await tool("focus_terminal", { terminal_id: other.terminalId });
  await page.waitForFunction(
    (id) =>
      document.activeElement
        ?.closest("[data-layer-id]")
        ?.getAttribute("data-layer-id") === id,
    other.id,
  );
  await page.evaluate(() => {
    window.__mcpFocusEvents = [];
  });
  const shiftedOwner = await snapshot();
  await tool("split_pane", { pane_index: 0, direction: "horizontal", profile });
  await unchanged(
    "split before focused slot preserves input identity",
    shiftedOwner,
  );
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(
      { health, checkpoints, separateFocusTools: true, keyboardDelivery: true },
      null,
      2,
    ),
  );
  console.log(
    `MCP/REST 포커스 보존 ${checkpoints.length}개 검증 및 명시적 포커스·키보드 전달 통과`,
  );
} catch (error) {
  const diagnostic = await page.evaluate(async () => {
    const { useTerminalStartupStore } =
      await import("/src/stores/terminal-startup-store.ts");
    const { usePaneRevealStore } =
      await import("/src/stores/pane-reveal-store.ts");
    const { useTerminalStore } = await import("/src/stores/terminal-store.ts");
    const state = useTerminalStartupStore.getState();
    return {
      activePaneId: state.activePaneId,
      eligible: state.eligiblePaneIds,
      revealed: [...state.revealedPaneIds],
      requests: usePaneRevealStore.getState().requestCounts,
      terminals: useTerminalStore
        .getState()
        .instances.map(({ id, sessionReady }) => ({ id, sessionReady })),
    };
  });
  await writeFile(
    path.join(artifacts, "failure.json"),
    JSON.stringify({ error: String(error), checkpoints, diagnostic }, null, 2),
  );
  throw error;
} finally {
  if (focusListenerInstalled)
    await page.evaluate(() => {
      document.removeEventListener("focusin", window.__mcpFocusListener, true);
      document.removeEventListener("focusout", window.__mcpFocusListener, true);
      delete window.__mcpFocusListener;
      delete window.__mcpFocusEvents;
    });
  await tool("switch_workspace", { workspace_id: original.workspaceId });
  if (originalGrid.focusedTerminalId)
    await tool("focus_terminal", {
      terminal_id: originalGrid.focusedTerminalId,
    });
  else
    await page.evaluate(async (original) => {
      const { focusWorkspacePane, focusDockPane } =
        await import("/src/lib/workspace-transition.ts");
      const { useWorkspaceStore } =
        await import("/src/stores/workspace-store.ts");
      const { useGridStore } = await import("/src/stores/grid-store.ts");
      if (original.dock !== null)
        focusDockPane(original.dock, original.dockPane);
      else if (original.gridLayer !== null) {
        const ws = useWorkspaceStore.getState().getActiveWorkspace();
        focusWorkspacePane(
          ws.id,
          ws.panes.findIndex((slot) =>
            slot.layers.some((layer) => layer.id === original.gridLayer),
          ),
        );
      } else useGridStore.getState().setFocusedPane(null);
    }, original);
  for (const id of createdIds.reverse())
    await tool("delete_workspace", { workspace_id: id });
  await fetch(`${base}/mcp`, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": session },
  });
  await browser.close();
}
