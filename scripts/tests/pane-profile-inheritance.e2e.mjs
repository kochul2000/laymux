// 실제 dev UI·PTY·Remote 검증. dev를 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
// --remote-debugging-port=9343 및 별도 WEBVIEW2_USER_DATA_FOLDER로 시작한 뒤 실행한다.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const host = "http://127.0.0.1:19281";
const artifacts = path.join(root, ".screenshots/pane-profile");
await mkdir(artifacts, { recursive: true });
async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(host + "/api/v1" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.ok(text, `${route}: HTTP ${response.status} empty response`);
  const result = JSON.parse(text);
  assert.ok(
    response.ok && result.success !== false,
    `${route}: ${JSON.stringify(result)}`,
  );
  return result;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);
const tabs = await (
  await fetch(process.env.LAYMUX_PROFILE_CDP ?? "http://127.0.0.1:9343/json")
).json();
const target = tabs.find((tab) => tab.url.includes("1420"));
assert.ok(target, "dev WebView2");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) =>
  socket.addEventListener("open", resolve, { once: true }),
);
let serial = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const result = JSON.parse(data);
  pending.get(result.id)?.(result);
  pending.delete(result.id);
};
async function evaluate(expression) {
  const id = ++serial;
  const result = await new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  assert.ok(
    !result.error && !result.result.exceptionDetails,
    JSON.stringify(result),
  );
  return result.result.result.value;
}
const invoke = (command, args) =>
  evaluate(
    `(async()=>{const{invoke}=await import('/node_modules/@tauri-apps/api/core.js');return invoke(${JSON.stringify(command)},${JSON.stringify(args)})})()`,
  );
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout: ${message}`);
}
await evaluate(`(async()=>{
  window.profileCheck = {
    settings:(await import('/src/stores/settings-store.ts')).useSettingsStore,
    workspace:(await import('/src/stores/workspace-store.ts')).useWorkspaceStore,
    terminal:(await import('/src/stores/terminal-store.ts')).useTerminalStore,
    ui:(await import('/src/stores/ui-store.ts')).useUiStore,
  }; return true;
})()`);
const original = await evaluate(
  `({ terminal:profileCheck.settings.getState().terminal, profiles:profileCheck.settings.getState().profiles, remote:profileCheck.settings.getState().remote, workspace:profileCheck.workspace.getState().activeWorkspaceId })`,
);
const originalAccess = await invoke("get_remote_access_status");
assert.ok(
  !(await invoke("get_remote_control_status")).lease,
  "기존 Remote 제어권이 있습니다",
);
const token = crypto.randomUUID();
const profileName = `profile-check-${Date.now()}`;
let workspaceId;
let browser;
const results = [];
async function screenshot() {
  const { dataUrl: _dataUrl, ...metadata } = await api("/screenshot", {});
  return metadata;
}
async function setting(enabled) {
  await api("/ui/settings", {});
  await api("/ui/settings/navigate", { section: "terminal" });
  await until(
    () =>
      evaluate(
        `!!document.querySelector('[data-testid="inherit-profile-on-split-toggle"]')`,
      ),
    "설정 토글",
  );
  const initial = await evaluate(
    `document.querySelector('[data-testid="inherit-profile-on-split-toggle"]').getAttribute('aria-checked')`,
  );
  if (initial !== String(enabled))
    await evaluate(
      `document.querySelector('[data-testid="inherit-profile-on-split-toggle"]').click();true`,
    );
  await evaluate(
    `document.querySelector('[data-testid="save-settings-btn"]').click();true`,
  );
  await until(
    () =>
      evaluate(
        `profileCheck.settings.getState().terminal.inheritProfileOnSplit === ${enabled}`,
      ),
    "설정 저장",
  );
  results.push({ kind: "settings", enabled, screenshot: await screenshot() });
  await evaluate(`profileCheck.ui.getState().closeSettingsModal();true`);
}
async function ready(id, expectedProfile, verifyCwd = true) {
  await until(
    () =>
      evaluate(
        `profileCheck.terminal.getState().instances.some(i=>i.id===${JSON.stringify(`terminal-${id}`)} && i.sessionReady===true && i.profile===${JSON.stringify(expectedProfile)})`,
      ),
    `${id} PTY 프로필 ${expectedProfile}`,
  );
  const marker = `PROFILE_CHECK_${crypto.randomUUID().replaceAll("-", "")}`;
  await api(`/terminals/terminal-${id}/write`, { data: `echo ${marker}\r` });
  await until(
    async () =>
      JSON.stringify(
        await api(`/terminals/terminal-${id}/output?lines=30`),
      ).split(marker).length >= 3,
    "실제 셸 입출력",
  );
  const cwd = await until(
    () =>
      evaluate(
        `profileCheck.terminal.getState().instances.find(i=>i.id===${JSON.stringify(`terminal-${id}`)})?.cwd`,
      ),
    "실제 셸 CWD",
  );
  const normalized = cwd
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase())
    .replace(/\/$/, "");
  const expected = root
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase())
    .replace(/\/$/, "");
  if (verifyCwd) assert.equal(normalized, expected);
}
try {
  await evaluate(
    `(()=>{const s=profileCheck.settings.getState();s.addProfile({...s.profiles[0],name:${JSON.stringify(profileName)},commandLine:${JSON.stringify(process.env.LAYMUX_PROFILE_COMMAND ?? "powershell.exe -NoLogo -NoProfile")},startupCommand:'',startingDirectory:${JSON.stringify(root)},restoreCwd:false,restoreOutput:false,hidden:false});return true})()`,
  );
  await evaluate(
    `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
  );
  await evaluate(
    `(()=>{const s=profileCheck.workspace.getState();s.addWorkspace('프로필 상속 실기 검증',s.layouts[0].id);return true})()`,
  );
  workspaceId = await evaluate(
    `profileCheck.workspace.getState().workspaces.at(-1).id`,
  );
  await api("/workspaces/active", { id: workspaceId });
  await evaluate(
    `(()=>{const s=profileCheck.workspace.getState();s.setPaneView(0,{type:'TerminalView',profile:${JSON.stringify(profileName)},syncGroup:'none'});return true})()`,
  );
  const sourceId = await evaluate(
    `profileCheck.workspace.getState().getActiveWorkspace().panes[0].layers[0].id`,
  );
  await evaluate(
    `(async()=>{(await import('/src/stores/overrides-store.ts')).useOverridesStore.getState().setPaneOverride(${JSON.stringify(sourceId)},{controlBarMode:'pinned'});return true})()`,
  );
  await ready(sourceId, profileName);
  await setting(true);
  for (const [action, testId] of [
    ["horizontal", "pane-control-split-h"],
    ["vertical", "pane-control-split-v"],
    ["stack", "pane-control-stack"],
  ]) {
    const before = await evaluate(
      `profileCheck.workspace.getState().getActiveWorkspace().panes.flatMap(s=>s.layers.map(l=>l.id))`,
    );
    await evaluate(
      `(()=>{const node=document.querySelector('[data-layer-id="${sourceId}"] [data-testid="${testId}"]');if(!node)throw Error('분할 버튼 없음: ${testId}');node.click();return true})()`,
    );
    const layers = await evaluate(
      `profileCheck.workspace.getState().getActiveWorkspace().panes.flatMap(s=>s.layers)`,
    );
    const layer = layers.find((l) => !before.includes(l.id));
    assert.deepEqual(layer.view, {
      type: "TerminalView",
      profile: profileName,
    });
    await ready(layer.id, profileName);
    results.push({ kind: "desktop", enabled: true, action, id: layer.id });
  }
  results.push({ kind: "desktop-screenshot", screenshot: await screenshot() });
  await setting(false);
  // stack 후 숨겨진 원본을 다시 표시한다.
  await api("/terminals/terminal-" + sourceId + "/focus", {});
  for (const testId of [
    "pane-control-split-h",
    "pane-control-split-v",
    "pane-control-stack",
  ]) {
    const before = await evaluate(
      `profileCheck.workspace.getState().getActiveWorkspace().panes.flatMap(s=>s.layers.map(l=>l.id))`,
    );
    await evaluate(
      `document.querySelector('[data-layer-id="${sourceId}"] [data-testid="${testId}"]').click();true`,
    );
    const layers = await evaluate(
      `profileCheck.workspace.getState().getActiveWorkspace().panes.flatMap(s=>s.layers)`,
    );
    assert.deepEqual(layers.find((l) => !before.includes(l.id)).view, {
      type: "EmptyView",
    });
    results.push({ kind: "desktop", enabled: false, action: testId });
  }
  await invoke("set_remote_runtime_access", {
    enabled: true,
    authToken: token,
  });
  await evaluate(
    `profileCheck.settings.getState().setRemote({authToken:${JSON.stringify(token)},tailscaleOnly:false,allowedIps:['127.0.0.1/32','::1/128']});true`,
  );
  await evaluate(
    `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const outputs = [];
  page.on("websocket", (socket) => {
    const terminal = socket.url().match(/\/terminals\/([^/]+)\/output/);
    if (terminal) outputs.push(terminal[1]);
  });
  page.on("response", (r) => {
    if (r.url().includes("/remote/v1/session/claim"))
      console.log("Remote 인증 응답:", r.status());
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      "laymux.remote.keybar",
      JSON.stringify({
        zones: {
          main: { left: ["soft:stackPane"], center: [], right: [] },
          expanded: { left: [], center: [], right: [] },
        },
      }),
    ),
  );
  await api("/terminals/terminal-" + sourceId + "/focus", {});
  const claimed = page.waitForResponse(
    (r) => r.url().endsWith("/remote/v1/session/claim") && r.ok(),
  );
  await page.goto(
    host +
      "/remote/#" +
      new URLSearchParams({
        token,
        autoConnect: "1",
        clientName: "profile-dev-verification",
      }),
  );
  await page.screenshot({
    path: path.join(artifacts, "remote-connecting.png"),
  });
  await claimed;
  for (const enabled of [false, true]) {
    await evaluate(
      `profileCheck.settings.getState().setTerminal({inheritProfileOnSplit:${enabled}});true`,
    );
    await api("/terminals/terminal-" + sourceId + "/focus", {});
    // 실제 Remote에서 원본 행으로 다시 진입한다.
    await page.locator("#navToggle").tap();
    await page.locator(`[data-pane-row="${sourceId}"]`).tap();
    const stacked = page.waitForResponse(
      (r) => r.url().endsWith(`/panes/${sourceId}/stack`) && r.ok(),
    );
    await page.locator('[data-key="stackPane"]').tap();
    const response = await (await stacked).json();
    const data = response.data ?? response;
    const layer = await until(
      () =>
        evaluate(
          `profileCheck.workspace.getState().getActiveWorkspace().panes.flatMap(s=>s.layers).find(l=>l.id===${JSON.stringify(data.layerId)})`,
        ),
      "Remote 새 레이어",
    );
    if (enabled) assert.equal(layer.view.profile, profileName);
    else assert.equal(layer.view.profile, undefined);
    const runtime = await until(
      () =>
        evaluate(
          `profileCheck.terminal.getState().instances.find(i=>i.id===${JSON.stringify(data.terminalId)} && i.sessionReady===true)`,
        ),
      "Remote PTY 준비",
    );
    await ready(layer.id, runtime.profile, enabled);
    await until(
      () => outputs.at(-1) === data.terminalId,
      "Remote 새 터미널 출력 연결",
    );
    await page.screenshot({
      path: path.join(artifacts, `remote-${enabled}.png`),
    });
    results.push({
      kind: "remote",
      enabled,
      profile: runtime.profile,
      id: layer.id,
    });
  }
  await writeFile(
    path.join(artifacts, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      results.map(({ screenshot, ...result }) => result),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await invoke("set_remote_runtime_access", {
    enabled: originalAccess.runtimeEnabled,
    authToken: originalAccess.effectiveAuthToken || null,
  });
  await evaluate(
    `profileCheck.ui.getState().closeSettingsModal();profileCheck.settings.getState().setTerminal(${JSON.stringify(original.terminal)});profileCheck.settings.setState({profiles:${JSON.stringify(original.profiles)},remote:${JSON.stringify(original.remote)}});true`,
  );
  await api("/workspaces/active", { id: original.workspace });
  if (workspaceId)
    await evaluate(
      `profileCheck.workspace.getState().removeWorkspace(${JSON.stringify(workspaceId)});true`,
    );
  await evaluate(
    `(async()=>{await(await import('/src/lib/persist-session.ts')).persistSession();return true})()`,
  );
  socket.close();
}
