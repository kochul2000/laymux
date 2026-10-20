// 현재 워크트리의 dev에서 실행: node scripts/tests/mcp-pane-focus.e2e.mjs
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339 필요.
// WSL 검사 추가: LAYMUX_FOCUS_WSL_DISTRO, LAYMUX_FOCUS_WSL_URL=http://<Windows-host>:19281/mcp
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
// HMR can leave manual dynamic imports pointing at a previous store module.
// A fresh document makes the instrumentation observe the live application stores.
await page.reload();
await page.waitForSelector('[data-testid="workspace-area"]');
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
async function unchanged(label, expected, allowGridReindex = false) {
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
  if (!allowGridReindex)
    assert.deepEqual(
      await page.evaluate(() => window.__mcpGridEvents),
      [],
      `${label}: grid focus must not transition`,
    );
  assert.deepEqual(
    await page.evaluate(() => window.__mcpWorkspaceEvents),
    [],
    `${label}: workspace must not transition`,
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
  await page.evaluate(async () => {
    window.__mcpFocusEvents = [];
    window.__mcpGridEvents = [];
    window.__mcpWorkspaceEvents = [];
    const { useGridStore } = await import("/src/stores/grid-store.ts");
    const { useWorkspaceStore } =
      await import("/src/stores/workspace-store.ts");
    window.__mcpUnsubscribeWorkspace = useWorkspaceStore.subscribe(
      (state, before) => {
        if (state.activeWorkspaceId !== before.activeWorkspaceId)
          window.__mcpWorkspaceEvents.push({
            before: before.activeWorkspaceId,
            after: state.activeWorkspaceId,
            stack: new Error().stack,
          });
      },
    );
    window.__mcpUnsubscribeGrid = useGridStore.subscribe((state, before) => {
      if (state.focusedPaneIndex !== before.focusedPaneIndex)
        window.__mcpGridEvents.push({
          before: before.focusedPaneIndex,
          after: state.focusedPaneIndex,
          stack: new Error().stack,
        });
    });
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
  // ADR-0350: operate on an unvisited workspace while the human keeps typing here.
  const bgScope = { workspace_id: background.workspace.id };
  const bgFirst = backgroundId.replace(/^terminal-/, "");
  const { newPane: bgSplit } = await tool("split_pane", {
    ...bgScope,
    pane_index: 0,
    direction: "vertical",
    profile,
  });
  await unchanged("background split by workspace", owner);
  await tool("resize_pane", { ...bgScope, pane_index: 0, dw: 0.05 });
  await unchanged("background resize", owner);
  await tool("write_to_terminal", {
    terminal_id: bgSplit.terminalId,
    data: "echo BACKGROUND_SPLIT_READY",
  });
  await unchanged("background split terminal startup", owner);
  const bgGrid = await tool("get_grid_state", bgScope);
  assert.equal(bgGrid.workspaceId, background.workspace.id);
  assert.equal(bgGrid.activeWorkspaceId, owner.workspaceId);
  assert.equal(bgGrid.focusedTerminalId, ownerId);
  await unchanged(
    "background grid query preserves human focus projection",
    owner,
  );

  if (process.env.LAYMUX_FOCUS_WSL_DISTRO) {
    // Real Linux HTTP client and WSL shell PTY; no desktop navigation or agent process.
    const wslTool = (name, args) => {
      const python = `import json,sys,urllib.request
p=json.load(sys.stdin)
r=urllib.request.urlopen(urllib.request.Request(p['url'],data=json.dumps(p['body']).encode(),headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','Mcp-Session-Id':p['session']}),timeout=30)
s=r.read().decode()
if 'text/event-stream' in r.headers.get('content-type',''): s=next(x[5:] for x in s.splitlines() if x.startswith('data:') and x[5:].strip().startswith('{'))
print(s)`;
      const raw = execFileSync(
        "wsl.exe",
        [
          "-d",
          process.env.LAYMUX_FOCUS_WSL_DISTRO,
          "--exec",
          "python3",
          "-c",
          python,
        ],
        {
          input: JSON.stringify({
            url: process.env.LAYMUX_FOCUS_WSL_URL,
            session,
            body: {
              jsonrpc: "2.0",
              id: ++requestId,
              method: "tools/call",
              params: { name, arguments: args },
            },
          }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 35_000,
        },
      );
      const message = JSON.parse(raw);
      assert.ok(!message.error, raw);
      assert.ok(!message.result.isError, raw);
      return JSON.parse(
        message.result.content.find((c) => c.type === "text").text,
      );
    };
    assert.ok(process.env.LAYMUX_FOCUS_WSL_URL?.endsWith(":19281/mcp"));
    const wslProfile = await page.evaluate(
      async () =>
        (await import("/src/stores/settings-store.ts")).useSettingsStore
          .getState()
          .profiles.find((p) => /\bwsl(?:\.exe)?\b/i.test(p.commandLine))?.name,
    );
    assert.ok(
      wslProfile,
      "WSL shell profile is required for the WSL transport regression",
    );
    const { newPane: wslPane } = wslTool("split_pane", {
      ...bgScope,
      pane_index: 0,
      direction: "horizontal",
      profile: wslProfile,
      cwd: "/tmp",
    });
    wslTool("write_to_terminal", {
      terminal_id: wslPane.terminalId,
      data: "printf WSL_BACKGROUND_FOCUS_OK",
      capture_ms: 500,
    });
    let output;
    const shellDeadline = Date.now() + 15_000;
    do {
      output = wslTool("read_terminal_output", {
        terminal_id: wslPane.terminalId,
        format: "text",
        lines: 30,
      });
      if (/WSL_BACKGROUND_FOCUS_OK/.test(output.output)) break;
      await page.waitForTimeout(200);
    } while (Date.now() < shellDeadline);
    assert.match(output.output, /WSL_BACKGROUND_FOCUS_OK/);
    await unchanged(
      "WSL MCP client creates and writes a background WSL pane",
      owner,
    );
  }

  const { newPane: bgStableSplit } = await tool("split_pane", {
    pane_id: bgSplit.id,
    direction: "horizontal",
    profile,
  });
  await unchanged("background split by stable pane id", owner);
  const { newPane: bgLayer } = await tool("stack_pane", {
    pane_id: bgFirst,
    view_type: "MemoView",
  });
  await unchanged("background stack by stable pane id", owner);
  await tool("move_pane_layer", { layer_id: bgLayer.id, target_pane_index: 1 });
  await unchanged("background move layer", owner);
  await tool("extract_pane_layer", {
    layer_id: bgLayer.id,
    direction: "vertical",
  });
  await unchanged("background extract layer", owner);
  await tool("swap_panes", { ...bgScope, source_index: 0, target_index: 1 });
  await unchanged("background swap", owner);
  await tool("merge_panes", { ...bgScope, source_index: 0, target_index: 1 });
  await unchanged("background merge", owner);
  const destination = await tool("create_workspace", {
    name: "Background move destination",
  });
  createdIds.push(destination.workspace.id);
  await tool("move_pane_to_workspace", {
    pane_id: bgStableSplit.id,
    source_workspace_id: background.workspace.id,
    workspace_id: destination.workspace.id,
  });
  await tool("remove_pane", { pane_id: bgLayer.id, layer_id: bgLayer.id });
  await unchanged(
    "background stable-id creation, rearrangement, movement and cleanup",
    owner,
  );
  for (const [name, args] of [
    ["split_pane", { pane_index: 0, direction: "vertical" }],
    ["stack_pane", { pane_index: 0 }],
    ["remove_pane", { pane_index: 0 }],
    ["resize_pane", { pane_index: 0, dw: 0.1 }],
    ["swap_panes", { source_index: 0, target_index: 1 }],
    ["merge_panes", { source_index: 0, target_index: 1 }],
  ])
    await tool(name, { ...args, workspace_id: "missing-workspace" }, true);
  await unchanged(
    "unknown workspace never falls back to human workspace",
    owner,
  );

  const restSplitResponse = await fetch(`${base}/api/v1/panes/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paneId: bgFirst, direction: "vertical", profile }),
  });
  assert.ok(restSplitResponse.ok, await restSplitResponse.clone().text());
  const restSplit = await restSplitResponse.json();
  const restGrid = await (
    await fetch(`${base}/api/v1/grid?workspaceId=${background.workspace.id}`)
  ).json();
  const restIndex = restGrid.panes.find(
    (p) => p.paneId === restSplit.newPane.id,
  ).paneIndex;
  const removed = await fetch(
    `${base}/api/v1/panes/${restIndex}?workspaceId=${background.workspace.id}&paneId=${restSplit.newPane.id}`,
    { method: "DELETE" },
  );
  assert.ok(removed.ok, await removed.clone().text());
  assert.equal((await removed.json()).removed, true);
  await unchanged(
    "REST background stable-id split, grid query and removal",
    owner,
  );

  // Do not rely on instrumentation flushing React between each operation.
  const burst = await tool("create_workspace", {
    name: "Background mutation burst",
  });
  createdIds.push(burst.workspace.id);
  const burstFirst = (await seedTerminal(burst.workspace.id, profile)).replace(
    /^terminal-/,
    "",
  );
  const burstScope = { workspace_id: burst.workspace.id };
  const { newPane: burstRight } = await tool("split_pane", {
    pane_id: burstFirst,
    direction: "vertical",
    profile,
  });
  const { newPane: burstBottom } = await tool("split_pane", {
    pane_id: burstRight.id,
    direction: "horizontal",
    profile,
  });
  const { newPane: burstLayer } = await tool("stack_pane", {
    pane_id: burstFirst,
    view_type: "MemoView",
  });
  await tool("move_pane_layer", {
    layer_id: burstLayer.id,
    target_pane_index: 1,
  });
  await tool("extract_pane_layer", {
    layer_id: burstLayer.id,
    direction: "vertical",
  });
  await tool("swap_panes", { ...burstScope, source_index: 0, target_index: 1 });
  await tool("merge_panes", {
    ...burstScope,
    source_index: 0,
    target_index: 1,
  });
  await tool("move_pane_to_workspace", {
    pane_id: burstBottom.id,
    workspace_id: destination.workspace.id,
  });
  await tool("remove_pane", {
    pane_id: burstLayer.id,
    layer_id: burstLayer.id,
  });
  await unchanged(
    "consecutive background mutations without instrumentation frame gaps",
    owner,
  );

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
  const screenshot = await (
    await fetch(`${base}/api/v1/screenshot`, { method: "POST" })
  ).json();
  assert.ok(screenshot.dataUrl?.startsWith("data:image/png;base64,"));
  await writeFile(
    path.join(artifacts, "api-preserved.png"),
    Buffer.from(screenshot.dataUrl.split(",")[1], "base64"),
  );
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
    window.__mcpGridEvents = [];
    window.__mcpWorkspaceEvents = [];
  });
  const shiftedOwner = await snapshot();
  await tool("split_pane", { pane_index: 0, direction: "horizontal", profile });
  await unchanged(
    "split before focused slot preserves input identity",
    shiftedOwner,
    true,
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
      gridEvents: window.__mcpGridEvents,
      workspaceEvents: window.__mcpWorkspaceEvents,
      focusEvents: window.__mcpFocusEvents,
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
      window.__mcpUnsubscribeGrid?.();
      window.__mcpUnsubscribeWorkspace?.();
      delete window.__mcpUnsubscribeGrid;
      delete window.__mcpUnsubscribeWorkspace;
      delete window.__mcpGridEvents;
      delete window.__mcpWorkspaceEvents;
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
