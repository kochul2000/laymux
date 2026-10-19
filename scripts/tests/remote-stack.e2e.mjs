// 현재 워크트리의 dev와 실제 Remote 페이지·PTY로 Stack 진입/스킵을 검증한다.
// 실행: node scripts/tests/remote-stack.e2e.mjs (dev CDP 기본 포트 9342)
// PTY 수명 검증용 dev는 VITE_LAYMUX_STRICT_MODE=0으로 시작한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";

const host = "http://127.0.0.1:19281";
const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, ".screenshots/remote-stack");
async function api(endpoint, body, method = body ? "POST" : "GET") {
  const response = await fetch(`${host}/api/v1${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  assert.ok(text, `${endpoint}: 빈 응답 (${response.status})`);
  const value = JSON.parse(text);
  assert.ok(response.ok && value.success !== false, JSON.stringify(value));
  return value;
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 30_000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`${label}: 대기 시간 초과: ${JSON.stringify(value)}`);
}

const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.gitCommit,
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
);
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);
await mkdir(artifacts, { recursive: true });
const desktop = await chromium.connectOverCDP(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
);
const desktopPage = desktop
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith("http://localhost:1420/"));
assert.ok(desktopPage, "dev WebView가 필요합니다.");
const invoke = (command, args) =>
  desktopPage.evaluate(
    async ({ command, args }) => {
      const { invoke } = await import("/node_modules/@tauri-apps/api/core.js");
      return invoke(command, args);
    },
    { command, args },
  );
const access = await invoke("get_remote_access_status");
assert.ok(
  !(await invoke("get_remote_control_status")).lease,
  "기존 Remote 제어권이 있습니다.",
);
const originalWorkspace = (await api("/workspaces/active")).workspace.id;
const token = access.effectiveAuthToken || "stack-dev-verification";
let browser;
let workspace;
let remote;
let ownedLease;
const results = [];
try {
  await invoke("set_remote_runtime_access", {
    enabled: true,
    authToken: token,
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const profile of ["PowerShell", "WSL"]) {
    workspace = (
      await api("/workspaces", {
        name: `Remote Stack 검증 ${profile}`,
        layoutId: "default-layout",
      })
    ).workspace.id;
    await api("/workspaces/active", { id: workspace });
    await api("/panes/0/view", { type: "TerminalView", profile }, "PUT");
    const source = (await api("/workspaces/active")).workspace.panes[0];
    await until(
      () => api("/terminals"),
      (data) => data.instances.some((t) => t.id === source.terminalId),
      "소스 PTY",
    );
    // 셸이 실제로 준비된 뒤, 프로필 기본 디렉터리와 다른 CWD를 만든다.
    await api(`/terminals/${source.terminalId}/write`, {
      data: (profile === "WSL" ? "cd /tmp" : "Set-Location $env:TEMP") + "\r",
    });
    const sourceState = await until(
      () => api("/terminals"),
      (data) =>
        data.instances.some(
          (t) =>
            t.id === source.terminalId &&
            (profile === "WSL" ? t.cwd === "/tmp" : /temp$/i.test(t.cwd || "")),
        ),
      "소스 CWD",
    );
    const cwd = sourceState.instances.find(
      (t) => t.id === source.terminalId,
    ).cwd;
    const context = await browser.newContext({
      viewport: { width: 720, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        "laymux.remote.keybar",
        JSON.stringify({
          zones: {
            main: { left: ["soft:stackPane"], center: [], right: [] },
            expanded: { left: [], center: [], right: [] },
          },
        }),
      );
      let Constructor;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get: () => Constructor,
        set: (value) => {
          Constructor = class extends value {
            constructor(...args) {
              super(...args);
              window.__stackTerminal = this;
            }
          };
        },
      });
    });
    remote = await context.newPage();
    const outputs = [];
    remote.on("websocket", (socket) => {
      const terminalId = new URL(socket.url()).pathname.match(
        /terminals\/([^/]+)\/output/,
      )?.[1];
      if (terminalId) outputs.push(terminalId);
    });
    const claimed = remote.waitForResponse(
      (response) => response.url().endsWith("/session/claim") && response.ok(),
    );
    await remote.goto(
      `${host}/remote/#${new URLSearchParams({ token, autoConnect: "1", clientName: "stack-dev-verification" })}`,
    );
    ownedLease = (await (await claimed).json()).leaseId;
    const stack = remote.locator('#mainActionRow [data-key="stackPane"]');
    await stack.waitFor({ state: "visible" });
    await until(() => stack.isEnabled(), Boolean, "Stack 버튼");
    const stacked = remote.waitForResponse((response) =>
      /\/panes\/[^/]+\/stack$/.test(response.url()),
    );
    await stack.tap();
    const stackResponse = await stacked;
    assert.ok(stackResponse.ok());
    const payload = await stackResponse.json();
    const panes = (await api("/workspaces/active")).workspace.panes;
    const created = panes.find((pane) => pane.id === payload.layerId);
    assert.ok(created, "새 레이어가 있어야 합니다.");
    await until(
      () => Promise.resolve(outputs.at(-1)),
      (id) => id === created.terminalId,
      "Stack 직후 자동 연결",
    );
    await remote.locator("#navToggle").tap();
    await remote
      .locator(`[data-pane-row="${created.id}"]`)
      .waitFor({ state: "visible" });
    await remote.waitForTimeout(250); // drawer 전환 애니메이션 뒤 캡처
    await remote.screenshot({
      path: path.join(artifacts, `${profile}-drawer.png`),
    });
    assert.equal(
      created.view.type,
      "TerminalView",
      "Remote Stack은 진입 가능한 터미널이어야 합니다.",
    );
    assert.equal(payload.terminalId, created.terminalId);
    assert.equal(
      await remote
        .locator(`[data-pane-row="${created.id}"]`)
        .evaluate((el) => el.tagName),
      "BUTTON",
    );
    const skip = remote.locator(`[data-pane-skip="${created.id}"]`);
    await skip.waitFor({ state: "visible" });
    await skip.tap();
    assert.equal(await skip.getAttribute("aria-pressed"), "true");
    await skip.tap();
    assert.equal(await skip.getAttribute("aria-pressed"), "false");
    await remote.locator(`[data-pane-row="${source.id}"]`).tap();
    await remote.locator("#navToggle").tap();
    await remote.locator(`[data-pane-row="${created.id}"]`).tap();
    const session = await until(
      async () =>
        (await api("/terminals")).instances.find(
          (t) => t.id === created.terminalId,
        ),
      (t) => t?.cwd === cwd,
      `새 PTY CWD ${cwd}`,
    );
    assert.equal(session.profile, profile);
    const marker = `REMOTE_STACK_OK_${profile}`;
    const response = await remote.request.post(
      `${host}/remote/v1/terminals/${created.terminalId}/input`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          leaseId: ownedLease,
          text:
            profile === "WSL"
              ? "printf '%s%s\\n' 'REMOTE_' 'STACK_OK_WSL'"
              : "Write-Host ('REMOTE_' + 'STACK_OK_PowerShell')",
          submit: true,
        },
      },
    );
    assert.ok(response.ok());
    await until(
      () =>
        remote.evaluate(() => {
          const buffer = window.__stackTerminal?.buffer.active;
          return buffer
            ? Array.from({ length: buffer.length }, (_, i) =>
                buffer.getLine(i).translateToString(true),
              ).join("\n")
            : "";
        }),
      (text) => text.includes(marker),
      "Remote 실제 xterm 출력",
    );
    const screenshot = await api("/screenshot", undefined, "POST");
    await remote.screenshot({
      path: path.join(artifacts, `${profile}-output.png`),
    });
    results.push({
      profile,
      terminalId: created.terminalId,
      cwd,
      autoAttach: true,
      skip: true,
      reentry: true,
      marker,
      desktopScreenshot: screenshot.path,
    });
    await context.close();
    await until(
      () => invoke("get_remote_control_status"),
      (status) => !status.lease,
      "Remote 제어권 해제",
    );
    ownedLease = null;
    await api("/workspaces/active", { id: originalWorkspace });
    await api(`/workspaces/${workspace}`, undefined, "DELETE");
    workspace = null;
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify({ health: health.instance, results }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (remote && !remote.isClosed())
    await remote
      .screenshot({ path: path.join(artifacts, "last-state.png") })
      .catch(() => {});
  if (ownedLease)
    await fetch(`${host}/remote/v1/session/release`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ leaseId: ownedLease }),
    }).catch(() => {});
  await browser?.close();
  await api("/workspaces/active", { id: originalWorkspace });
  if (workspace) await api(`/workspaces/${workspace}`, undefined, "DELETE");
  await invoke("set_remote_runtime_access", {
    enabled: access.runtimeEnabled,
    authToken: access.effectiveAuthToken || null,
  });
  await desktop.close();
}
