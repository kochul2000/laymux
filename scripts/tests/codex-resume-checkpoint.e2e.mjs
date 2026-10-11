// 격리 dev의 실제 Codex를 검증한다. 모델 요청과 앱 종료는 하지 않는다.
// LAYMUX_CODEX_WORKSPACE, LAYMUX_CODEX_HOMES={terminalId:{root,distro}},
// LAYMUX_DEV_URL(기본 1439), LAYMUX_CDP_URL(기본 9342)을 지정한다.
// LAYMUX_EXPECT_NO_HOOKS=1이면 새 훅 없는 resume도 검증한다.
import { connectDevPage } from "./dev-cdp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const workspace = process.env.LAYMUX_CODEX_WORKSPACE;
const homes = JSON.parse(process.env.LAYMUX_CODEX_HOMES || "{}");
assert.ok(
  workspace && Object.keys(homes).length,
  "격리 workspace와 CODEX_HOME을 지정한다",
);
const base = "http://127.0.0.1:19281/api/v1";
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
  health.instance.worktreeRoot.toLowerCase(),
  path.resolve(".").toLowerCase(),
);
assert.equal(
  health.instance.gitBranch,
  execFileSync("git", ["branch", "--show-current"], {
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
);
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
  process.env.LAYMUX_DEV_URL || "http://localhost:1439",
);
assert.ok(page, "dev WebView가 필요하다");
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const original = await invoke("load_settings");
const terminals = (await api("/terminals")).instances.filter(
  (t) => t.workspaceId === workspace,
);
const ids = Object.keys(homes);
const manage = (id, operation) =>
  api("/agent-hooks/manage", {
    provider: "codex",
    configDir: homes[id].root,
    distro: homes[id].distro,
    operation,
  });
for (const id of ids) {
  assert.ok(
    terminals.some((t) => t.id === id),
    "사용자 terminal은 다루지 않는다",
  );
  const home = homes[id].root.replaceAll("\\", "/").toLowerCase();
  assert.ok(
    home.startsWith(
      homes[id].distro
        ? "/tmp/laymux-"
        : os.tmpdir().replaceAll("\\", "/").toLowerCase() + "/laymux-codex",
    ) ||
      (!homes[id].distro && /^[a-z]:\/(?:lm|laymux)-codex-[^/]+$/.test(home)),
  );
}
let token;
const begin = async () => {
  const checkpoint = await invoke("begin_codex_status_checkpoint");
  token = checkpoint.token;
  return checkpoint;
};
const finish = async () => {
  if (token) {
    const current = token;
    token = undefined;
    await invoke("finish_codex_status_checkpoint", { token: current });
  }
};
const mode = (stateDetection) =>
  page.evaluate(async (stateDetection) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const current = await invoke("load_settings");
    const codex = { ...current.codex, stateDetection };
    const { useSettingsStore } = await import("/src/stores/settings-store.ts");
    useSettingsStore.setState({ codex });
    await invoke("save_settings", { settings: { ...current, codex } });
  }, stateDetection);
const results = [];
try {
  await api("/workspaces/active", { id: workspace });
  await mode("hooks");
  const sessions = await invoke("get_terminal_session_attributions");
  const observations = (await api("/agent-hooks/connections")).data;
  for (const id of ids) {
    assert.equal(sessions[id]?.provider, "codex");
    assert.equal(sessions[id]?.state, "identified");
    if (process.env.LAYMUX_EXPECT_NO_HOOKS === "1")
      assert.ok(
        !observations.some(
          (o) =>
            o.sessionId === sessions[id].sessionId && o.event !== "SessionEnd",
        ),
        "새 훅이 없는 resume를 재현해야 한다",
      );
    await invoke("write_terminal_input", {
      id,
      text: "resume-draft-preserved",
      submit: false,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = new Map(
    await Promise.all(
      ids.map(async (id) => [
        id,
        await api(`/terminals/${id}/buffer?limit=80`),
      ]),
    ),
  );
  const started = performance.now();
  const checkpoint = await begin();
  assert.deepEqual(
    checkpoint.targets,
    [],
    "resume 직후 /status 입력과 resize가 없어야 한다",
  );
  const verified = await invoke("get_terminal_session_attributions");
  for (const id of ids) {
    assert.equal(verified[id].sessionId, sessions[id].sessionId);
    await assert.rejects(
      invoke("codex_status_checkpoint_input", {
        token,
        terminalId: id,
        step: "clear",
      }),
      /already verified/,
    );
    const after = await api(`/terminals/${id}/buffer?limit=80`);
    assert.equal(after.cols, before.get(id).cols);
    assert.equal(after.rows, before.get(id).rows);
    assert.ok(
      after.lines.some((l) => l.text.includes("resume-draft-preserved")),
      "입력 초안이 유지되어야 한다",
    );
  }
  const committed = await page.evaluate(async () => {
    const { flushSessionCheckpoint } =
      await import("/src/lib/persist-session.ts");
    return flushSessionCheckpoint({ reason: "close", requireConclusive: true });
  });
  const saved = await invoke("load_settings");
  for (const id of ids) {
    const paneId = terminals
      .find((t) => t.id === id)
      .id.replace(/^terminal-/, "");
    const pane = saved.workspaces
      .find((w) => w.id === workspace)
      .panes.find((p) => p.id === paneId);
    assert.equal(pane.view.lastCodexSession, sessions[id].sessionId);
  }
  const checkpointMs = Math.round(performance.now() - started);
  await finish();
  results.push(
    `실제 대화: 정확한 ID와 디스크 commit ${committed.checkpointCommitId}, /status·resize 생략, 초안 보존 (${checkpointMs}ms)`,
  );
  for (const id of ids) {
    await begin();
    try {
      await manage(id, "remove");
      const current = await invoke("get_terminal_session_attributions");
      assert.equal(current[id].sessionId, sessions[id].sessionId);
    } finally {
      await finish();
      await manage(id, "install");
    }
    try {
      await manage(id, "remove");
      const current = await begin();
      assert.deepEqual(
        current.targets,
        [],
        "설치 제거가 현재 대화 증거를 지우지 않는다",
      );
    } finally {
      await finish();
      await manage(id, "install");
    }
  }
  results.push(
    "현재 대화 증거는 훅 설치 제거 후에도 유효하며 설치 검사 I/O가 필요 없다",
  );
  await mode("heuristic");
  const fallback = await begin();
  assert.deepEqual(
    fallback.targets.map((t) => t.terminalId).sort(),
    [...ids].sort(),
  );
  await finish();
  results.push("휴리스틱 모드의 기존 /status 정책 유지");
  console.log(
    JSON.stringify(
      {
        results,
        sessions: ids.map((id) => ({
          terminalId: id,
          distro: homes[id].distro,
          sessionId: sessions[id].sessionId,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await finish();
  await mode(original.codex.stateDetection);
  await page.close();
}
