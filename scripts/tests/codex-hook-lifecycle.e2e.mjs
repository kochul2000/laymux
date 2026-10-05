// 실제 Codex를 띄운 격리 dev workspace에서 실행한다. release에는 연결하지 않는다.
// LAYMUX_CODEX_WORKSPACE, LAYMUX_DEV_URL, LAYMUX_CDP_URL을 지정한다.
// 각 CLI는 /tmp/laymux-codex* 또는 OS temp/laymux-codex* CODEX_HOME을 사용하고
// 훅을 신뢰한 뒤 한 번의 응답을 완료해야 한다. 사용자 CLI에 실행하지 않는다.
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const base = "http://127.0.0.1:19281/api/v1";
const workspace = process.env.LAYMUX_CODEX_WORKSPACE;
assert.ok(workspace, "격리 dev workspace ID를 지정해야 한다");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.ok(response.ok && data.success !== false, JSON.stringify(data));
  return data;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.worktreeRoot.replaceAll("\\", "/").toLowerCase(),
  path.resolve(".").replaceAll("\\", "/").toLowerCase(),
);
assert.equal(
  health.instance.gitBranch,
  execFileSync("git", ["branch", "--show-current"], {
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
);
const browser = await chromium.connectOverCDP(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) =>
    p.url().startsWith(process.env.LAYMUX_DEV_URL || "http://localhost:1439"),
  );
assert.ok(page, "dev WebView가 필요하다");
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const originalSettings = await invoke("load_settings");
const terminals = (await api("/terminals")).instances.filter(
  (t) => t.workspaceId === workspace,
);
const ids = terminals.map((t) => t.id);
const connections = (await api("/agent-hooks/connections")).data.filter((c) =>
  ids.includes(c.terminalId),
);
assert.equal(
  connections.length,
  2,
  "Windows와 WSL Codex의 실제 훅 수신이 필요하다",
);
assert.ok(connections.some((c) => c.distro === null));
assert.ok(connections.some((c) => c.distro !== null));
for (const c of connections) {
  const normalized = c.configDir.replaceAll("\\", "/").toLowerCase();
  const temp = os.tmpdir().replaceAll("\\", "/").toLowerCase();
  assert.ok(
    normalized.startsWith(
      c.distro ? "/tmp/laymux-codex" : temp + "/laymux-codex",
    ),
  );
  assert.equal(c.event, "Stop");
}
const manage = (c, operation) =>
  api("/agent-hooks/manage", {
    provider: "codex",
    configDir: c.configDir,
    distro: c.distro,
    operation,
  });
const mode = (stateDetection) =>
  invoke("save_settings", {
    settings: {
      ...originalSettings,
      codex: { ...originalSettings.codex, stateDetection },
    },
  });
let activeToken;
const begin = async () => {
  const result = await invoke("begin_codex_status_checkpoint", {});
  activeToken = result.token;
  return result;
};
const finish = async () => {
  if (!activeToken) return;
  const token = activeToken;
  activeToken = undefined;
  await invoke("finish_codex_status_checkpoint", { token });
};
const results = [];
try {
  await api("/workspaces/active", { id: workspace });
  await mode("hooks");
  for (const c of connections)
    await api(`/terminals/${c.terminalId}/write`, {
      data: "lifecycle-draft-preserved",
    });
  await pause(300);
  let checkpoint = await begin();
  assert.deepEqual(
    checkpoint.targets,
    [],
    "훅으로 확인한 pane에는 입력·resize가 없어야 한다",
  );
  const sessions = await invoke("get_terminal_session_attributions", {});
  for (const c of connections) {
    assert.equal(sessions[c.terminalId].sessionId, c.sessionId);
    assert.equal(sessions[c.terminalId].state, "identified");
    await assert.rejects(
      invoke("codex_status_checkpoint_input", {
        token: checkpoint.token,
        terminalId: c.terminalId,
        step: "clear",
      }),
      /hooks/,
    );
    const buffer = await api(`/terminals/${c.terminalId}/buffer?limit=40`);
    assert.ok(
      buffer.lines.some((l) => l.text.includes("lifecycle-draft-preserved")),
    );
  }
  await finish();
  results.push("Windows·WSL: 훅 ID 귀속, 입력 거부, 초안 보존");

  // phase 기한 경과와 다른 대화 수신 뒤에도 lifecycle 메타데이터를 유지한다.
  const newest = Math.max(...connections.map((c) => c.receivedAtMs));
  const remaining = Math.max(0, newest + 61_000 - Date.now());
  if (remaining) await pause(Math.min(remaining, 30_000));
  if (newest + 61_000 > Date.now()) await pause(newest + 61_000 - Date.now());
  await api("/agent-hooks/events", {
    terminalId: "lifecycle-unrelated",
    token: "fixture",
    provider: "codex",
    sessionId: "00000000-0000-4000-8000-000000000001",
    event: "Stop",
    emittedAtMs: Date.now(),
    ancestors: [],
    distro: null,
    configDir: connections.find((c) => c.distro === null).configDir,
  });
  checkpoint = await begin();
  assert.deepEqual(checkpoint.targets, []);
  await finish();
  results.push("작업 phase 만료 후에도 훅 종료 복원점 유지");

  // fence 안에서도 외부 설정 제거를 저장용 조회에서 재검증한다.
  checkpoint = await begin();
  const native = connections.find((c) => c.distro === null);
  try {
    await manage(native, "remove");
    await assert.rejects(
      invoke("get_terminal_session_attributions", {}),
      /hook conversation changed/,
    );
  } finally {
    await finish();
    await manage(native, "install");
  }
  results.push("검증 후 훅 제거는 저장 차단");

  for (const c of connections) {
    try {
      await manage(c, "remove");
      checkpoint = await begin();
      assert.deepEqual(
        checkpoint.targets.map((t) => t.terminalId),
        [c.terminalId],
      );
    } finally {
      await finish();
      await manage(c, "install");
    }
  }
  results.push("Windows·WSL: 미설치 pane만 /status fallback 대상으로 선택");

  await mode("heuristic");
  checkpoint = await begin();
  assert.deepEqual(
    checkpoint.targets.map((t) => t.terminalId).sort(),
    [...ids].sort(),
  );
  await finish();
  const fallback = await page.evaluate(async (ids) => {
    const original = window.__TAURI_INTERNALS__.invoke;
    let verified;
    try {
      const probe = await import("/src/lib/codex-status-probe.ts");
      await probe.withCodexStatusCheckpoint(true, undefined, async () => {
        const sessions = await original(
          "get_terminal_session_attributions",
          {},
        );
        for (const id of ids)
          if (!sessions[id]?.sessionId) throw Error("missing session");
        verified = ids.map((id) => ({
          terminalId: id,
          sessionId: sessions[id].sessionId,
        }));
        throw Error("fixture-checkpoint-cancel");
      });
      throw Error("fixture must cancel without closing dev");
    } catch (error) {
      if (!String(error).includes("fixture-checkpoint-cancel")) throw error;
    }
    return verified;
  }, ids);
  for (const c of connections)
    assert.ok(
      fallback.some(
        (r) => r.terminalId === c.terminalId && r.sessionId === c.sessionId,
      ),
    );
  results.push("Windows·WSL Codex 0.160: 실제 /status fallback 화면 검증");
  console.log(JSON.stringify({ results }, null, 2));
  if (process.env.LAYMUX_CAPTURE_SCREENSHOT === "1")
    console.log(JSON.stringify(await api("/screenshot", {}), null, 2));
} finally {
  await finish();
  await invoke("save_settings", { settings: originalSettings });
  await browser.close();
}
