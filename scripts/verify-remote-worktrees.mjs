// dev(19281)에서 실제 Git·Remote 모바일 UI·MCP를 검증한다.
// 검증 후 독립 UX 평가용 fixture/워크스페이스와 임시 Remote 접근을 남긴다.
// 평가 종료 후 node scripts/verify-remote-worktrees.mjs --restore 로 접근 설정을 복원한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".screenshots/remote-worktrees");
const sessionFile = path.join(artifacts, "session.json");
const host = "http://127.0.0.1:19281";
await mkdir(artifacts, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(host + "/api/v1" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.ok(
    response.ok && value.success !== false,
    `${route}: ${JSON.stringify(value)}`,
  );
  return value;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);

// Raw CDP also works when Playwright cannot attach to WebView2 shared workers.
const tabs = await (await fetch("http://127.0.0.1:9342/json")).json();
const target = tabs.find((tab) => tab.url.includes("1420"));
assert.ok(target, "dev WebView2 target");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) =>
  socket.addEventListener("open", resolve, { once: true }),
);
let nextId = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const result = JSON.parse(data);
  if (!result.id) return;
  pending.get(result.id)?.(result);
  pending.delete(result.id);
};
async function evaluate(expression) {
  const result = await new Promise((resolve) => {
    const id = ++nextId;
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
const persist = () =>
  evaluate(
    "(async()=>{const{persistSession}=await import('/src/lib/persist-session.ts');await persistSession();return true;})()",
  );
async function restore(session) {
  await invoke("set_remote_runtime_access", {
    enabled: session.originalAccess.runtimeEnabled,
    authToken: session.originalAccess.effectiveAuthToken || null,
  });
  await api("/workspaces/active", { id: session.originalWorkspace });
  await persist();
}
if (process.argv.includes("--restore")) {
  try {
    await restore(JSON.parse(await readFile(sessionFile, "utf8")));
  } finally {
    socket.close();
  }
  console.log("임시 Remote 접근과 활성 워크스페이스 복원 완료");
  process.exit(0);
}
function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function fixture() {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "laymux-remote-worktrees-"),
  );
  const main = path.join(base, "main");
  await mkdir(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Laymux Remote verification");
  git(main, "config", "user.email", "laymux-dev@example.invalid");
  await writeFile(path.join(main, "README.md"), "리모트 워크트리 검증\n");
  await writeFile(path.join(main, ".gitignore"), "local-secret.txt\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "fixture");
  const paths = {};
  for (const name of [
    "done-api",
    "done-ui",
    "ready-for-review",
    "dirty",
    "ignored",
    "in-use",
  ]) {
    paths[name] = path.join(base, name);
    git(main, "worktree", "add", "-b", name, paths[name]);
  }
  await writeFile(
    path.join(paths.dirty, "README.md"),
    "보존해야 하는 리모트 변경\n",
  );
  await writeFile(path.join(paths.dirty, "notes.txt"), "리모트 미추적 메모\n");
  await writeFile(
    path.join(paths.ignored, "local-secret.txt"),
    "보존해야 하는 ignored 파일\n",
  );
  return { base, main, paths };
}
const originalAccess = await invoke("get_remote_access_status");
assert.ok(
  !(await invoke("get_remote_control_status")).lease,
  "기존 Remote 제어권이 있습니다",
);
const originalWorkspace = (await api("/workspaces/active")).workspace.id;
const session = {
  originalAccess,
  originalWorkspace,
  token: crypto.randomUUID(),
  fixture: await fixture(),
};
const results = [];
let browser;
let leaseId;
async function remote(route, body, expected = 200, auth = true) {
  const response = await fetch(host + "/remote/v1" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${route}: ${text}`);
  return response.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
}
try {
  await invoke("set_remote_runtime_access", {
    enabled: true,
    authToken: session.token,
  });
  session.workspace = (
    await api("/workspaces", {
      name: "remote-worktree-demo",
      layoutId: "default-layout",
    })
  ).workspace.id;
  await api("/workspaces/active", { id: session.workspace });
  await api(
    "/panes/0/view",
    {
      type: "TerminalView",
      profile: "PowerShell",
      lastCwd: session.fixture.main,
      syncGroup: "none",
      cwdSend: false,
      cwdReceive: false,
    },
    "PUT",
  );
  await api("/panes/split", {
    paneIndex: 0,
    direction: "vertical",
    profile: "PowerShell",
    cwd: session.fixture.paths["in-use"],
  });
  await api("/grid/focus", { paneIndex: 0 });
  const panes = (await api("/workspaces/active")).workspace.panes;
  // A fresh workspace can start its default terminal before setView arrives.
  // Enter the fixture through the real shell rather than relying on a seed CWD.
  for (const [index, cwd] of [
    session.fixture.main,
    session.fixture.paths["in-use"],
  ].entries()) {
    const id = panes[index].terminalId || `terminal-${panes[index].id}`;
    await api(`/terminals/${id}/write`, {
      data: `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'\r`,
    });
  }
  let terminals;
  for (let attempt = 0; attempt < 60; attempt++) {
    terminals = (await api("/terminals")).instances;
    const samePath = (a, b) =>
      a
        ?.replaceAll("\\", "/")
        .replace(/^\/mnt\/([a-z])\//, "$1:/")
        .toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
    const source = terminals.find((row) =>
      samePath(row.cwd, session.fixture.main),
    );
    const used = terminals.find((row) =>
      samePath(row.cwd, session.fixture.paths["in-use"]),
    );
    if (source && used) {
      session.source = source.id;
      session.used = used.id;
      break;
    }
    await delay(500);
  }
  assert.ok(session.source && session.used, "fixture 터미널 CWD 관측");
  await persist();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const claimed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/remote/v1/session/claim") && response.ok(),
  );
  session.url =
    host +
    "/remote/#" +
    new URLSearchParams({
      token: session.token,
      autoConnect: "1",
      clientName: "worktrees-dev-verification",
    });
  await page.goto(session.url);
  leaseId = (await (await claimed).json()).leaseId;
  await page.locator("#worktreesHeader").waitFor();
  const route = `/terminals/${session.source}/worktrees`;
  const list = await remote(route, { leaseId });
  assert.equal(list.data.worktrees.length, 7);
  assert.deepEqual(list.data.usageWarnings, []);
  results.push("실제 Git 워크트리 7개 조회·현재 터미널 기준 대상 확정");
  await remote(route, { leaseId }, 401, false);
  await remote(route, { leaseId: "stale" }, 409);
  await remote(route, {}, 422);
  const inspect = async (tree) =>
    (await remote(route + "/inspect", { leaseId, cwd: list.cwd, path: tree }))
      .data;
  const remove = (tree, head, expected = 200) =>
    remote(
      route + "/remove",
      { leaseId, cwd: list.cwd, path: tree, expectedHead: head },
      expected,
    );
  await remote(
    route + "/inspect",
    { leaseId, cwd: "stale-cwd", path: session.fixture.paths.dirty },
    409,
  );
  await remote(
    route + "/remove",
    {
      leaseId,
      cwd: list.cwd,
      path: session.fixture.paths["done-api"],
      expectedHead: "stale",
      force: true,
    },
    422,
  );
  results.push("무인증·누락/오래된 lease·변경된 CWD·force 입력 거부");
  for (const name of ["dirty", "ignored", "in-use"]) {
    const tree = session.fixture.paths[name];
    const detail = await inspect(tree);
    assert.equal(detail.canRemove, false, JSON.stringify(detail));
    await remove(tree, detail.worktree.head, 409);
    await access(tree);
    if (name === "in-use")
      assert.ok(
        detail.usage.some((entry) => entry.terminalId === session.used),
      );
  }
  results.push("변경·미추적·ignored·실제 사용 중 워크트리 제거 거부·폴더 보존");
  const done = await inspect(session.fixture.paths["done-api"]);
  assert.equal(done.canRemove, true, JSON.stringify(done));
  await remove(session.fixture.paths["done-api"], done.worktree.head);
  await assert.rejects(access(session.fixture.paths["done-api"]));
  assert.equal(
    git(session.fixture.main, "rev-parse", "done-api"),
    done.worktree.head,
  );
  results.push("실제 Remote API 제거·브랜치 보존");
  const row = (tree) =>
    page.locator("button[data-worktree-path]").filter({
      has: page.locator("span.worktree-path", {
        hasText: tree.replaceAll("\\", "/"),
      }),
    });
  await page.locator("#worktreesHeader").click();
  await page.waitForFunction(
    () =>
      document.getElementById("worktreesAll").textContent === "전체 6" &&
      !document
        .getElementById("worktreesStatus")
        .textContent.includes("내용 검사"),
  );
  assert.equal(
    await page.locator("#worktreesCandidates").textContent(),
    "정리 후보 2",
  );
  await page.screenshot({ path: path.join(artifacts, "mobile-list.png") });
  await row(session.fixture.paths.dirty).click();
  await page
    .getByRole("button", { name: "워크트리 제거", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "워크트리 제거", exact: true })
      .isDisabled(),
    true,
  );
  await page.locator("#worktreesDetail summary").click();
  await page
    .getByRole("button", { name: "미추적 · notes.txt", exact: true })
    .click();
  await page.locator("#fileViewerOverlay").waitFor();
  await page.getByText("리모트 미추적 메모", { exact: false }).waitFor();
  await page.screenshot({
    path: path.join(artifacts, "mobile-file-viewer.png"),
  });
  await page.locator("#fileViewerClose").click();
  await page.locator("#worktreesHeader").click();
  await row(session.fixture.paths["done-ui"]).click();
  await page
    .getByRole("button", { name: "워크트리 제거", exact: true })
    .click();
  await page
    .getByText("폴더를 제거합니다. 브랜치는 유지됩니다.", { exact: false })
    .waitFor();
  await page.screenshot({
    path: path.join(artifacts, "mobile-remove-confirmation.png"),
  });
  await page.getByRole("button", { name: "제거 확인", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("worktreesAll").textContent === "전체 5",
  );
  await assert.rejects(access(session.fixture.paths["done-ui"]));
  git(session.fixture.main, "rev-parse", "done-ui");
  assert.deepEqual(pageErrors, []);
  results.push(
    "390×844 모바일 실제 화면 목록·파일 열기·두 단계 확인 제거·브랜치 보존",
  );

  let mcpSession;
  async function mcp(method, params, id = 1) {
    const response = await fetch(host + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        ...(id === null ? {} : { id }),
      }),
    });
    assert.ok(response.ok, `MCP ${method}: ${response.status}`);
    mcpSession = response.headers.get("mcp-session-id") || mcpSession;
    const body = await response.text();
    if (!body) return;
    return JSON.parse(
      body.startsWith("event:") || body.startsWith("data:")
        ? body
            .split("\n")
            .find((line) => line.startsWith("data:") && line.slice(5).trim())
            .slice(5)
        : body,
    );
  }
  await mcp("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "worktrees-dev-verification", version: "1" },
  });
  await mcp("notifications/initialized", {}, null);
  const tools = (await mcp("tools/list", {}, 2)).result.tools;
  const tool = tools.find((entry) => entry.name === "get_worktree_usage");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(
    !tools.some((entry) =>
      ["list_worktrees", "inspect_worktree", "remove_worktree"].includes(
        entry.name,
      ),
    ),
  );
  const usageResult = (
    await mcp(
      "tools/call",
      {
        name: "get_worktree_usage",
        arguments: { path: session.fixture.paths["in-use"] },
      },
      3,
    )
  ).result;
  assert.ok(!usageResult.isError, JSON.stringify(usageResult));
  const observation = JSON.parse(
    usageResult.content.find((entry) => entry.type === "text").text,
  );
  assert.equal(observation.scope, "current_build");
  assert.equal(observation.complete, true);
  assert.ok(
    observation.usage.some(
      (entry) => entry.terminalId === session.used && entry.kind === "live",
    ),
  );
  assert.equal(observation.canRemove, undefined);
  results.push(
    "실제 MCP handshake·읽기 전용 도구 목록·실행 중 사용 참조 조회·Git 관리 도구 없음",
  );
  const wsl = terminals.find((entry) => /WSL/.test(entry.profile));
  if (wsl) {
    await api("/workspaces/active", { id: wsl.workspaceId });
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = (await api("/terminals")).instances.find(
        (entry) => entry.id === wsl.id,
      );
      if (current?.sessionReady) break;
      await delay(500);
    }
    const wslRoute = `/terminals/${wsl.id}/worktrees`;
    const wslList = await remote(wslRoute, { leaseId });
    assert.ok(wslList.data.repositoryPath.startsWith("//wsl.localhost/"));
    assert.ok(wslList.data.worktrees.length > 1);
    await remote(wslRoute + "/inspect", {
      leaseId,
      cwd: wslList.cwd,
      path: wslList.data.worktrees[0].path,
    });
    const wslUsage = (
      await mcp(
        "tools/call",
        {
          name: "get_worktree_usage",
          arguments: { path: wslList.data.repositoryPath },
        },
        4,
      )
    ).result;
    assert.ok(!wslUsage.isError, JSON.stringify(wslUsage));
    results.push(
      "실제 WSL 터미널 기반 Remote 목록·검사 및 명시적 배포판 경로 MCP 조회",
    );
    await api("/workspaces/active", { id: session.workspace });
  }
  await remote("/session/release", { leaseId });
  leaseId = undefined;
  await writeFile(sessionFile, JSON.stringify(session, null, 2));
  await writeFile(
    path.join(artifacts, "results.json"),
    JSON.stringify(
      {
        health,
        results,
        workspace: session.workspace,
        fixture: session.fixture,
        observation,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { results, workspace: session.workspace, sessionFile },
      null,
      2,
    ),
  );
} catch (error) {
  if (leaseId) await remote("/session/release", { leaseId }).catch(() => {});
  await restore(session).catch(() => {});
  if (session.workspace)
    await api(`/workspaces/${session.workspace}`, undefined, "DELETE").catch(
      () => {},
    );
  throw error;
} finally {
  await browser?.close();
  socket.close();
}
