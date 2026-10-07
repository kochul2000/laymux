// 격리 dev만 사용한다. prepare 뒤 kill-dev.sh로 종료하고 같은 프로파일을
// 재기동한 뒤 verify를 실행한다. 실제 PC 전원 종료나 업데이트 설치는 하지 않는다.
// node scripts/tests/codex-restart-checkpoint.e2e.mjs prepare|verify .tmp/restart.json
// 환경: LAYMUX_CODEX_WORKSPACE, LAYMUX_CDP_URL, LAYMUX_DEV_URL
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connectDevPage } from "./dev-cdp.mjs";

const [mode, file] = process.argv.slice(2);
assert.ok(["prepare", "verify"].includes(mode) && file);
const workspace = process.env.LAYMUX_CODEX_WORKSPACE;
assert.ok(
  workspace?.startsWith("matrix-") || workspace?.startsWith("laymux-codex-"),
);
const base = "http://127.0.0.1:19281/api/v1";
const health = await (await fetch(`${base}/health`)).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.worktreeRoot.toLowerCase(),
  path.resolve(".").toLowerCase(),
);
const terminals = (await (await fetch(`${base}/terminals`)).json()).instances;
assert.ok(
  terminals.length && terminals.every((t) => t.workspaceId === workspace),
  "전체 종료는 격리 테스트 pane만 있을 때 허용한다",
);
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
  process.env.LAYMUX_DEV_URL || "http://localhost:1439",
);
const invoke = (command) =>
  page.evaluate(
    (command) => window.__TAURI_INTERNALS__.invoke(command),
    command,
  );
const savedSessions = (settings) =>
  Object.fromEntries(
    settings.workspaces
      .find((w) => w.id === workspace)
      .panes.filter(
        (p) => p.view.type === "TerminalView" && p.view.lastCodexSession,
      )
      .map((p) => [`terminal-${p.id}`, p.view.lastCodexSession]),
  );
try {
  if (mode === "prepare") {
    const live = await invoke("get_terminal_session_attributions");
    const sessions = {};
    for (const terminal of terminals) {
      if (live[terminal.id]?.state === "noAgent") continue;
      assert.equal(live[terminal.id]?.state, "identified");
      assert.equal(live[terminal.id]?.provider, "codex");
      sessions[terminal.id] = live[terminal.id].sessionId;
    }
    assert.ok(Object.keys(sessions).length, "Codex 대화가 필요하다");
    const preparation = await page.evaluate(async () => {
      const { saveBeforeClose } = await import("/src/lib/persist-session.ts");
      const stages = [];
      const started = performance.now();
      await saveBeforeClose((stage) => {
        stages.push(stage);
      });
      return { ms: Math.round(performance.now() - started), stages };
    });
    assert.deepEqual(savedSessions(await invoke("load_settings")), sessions);
    const snapshot = { appPid: health.instance.pid, sessions, preparation };
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    const before = JSON.parse(readFileSync(file, "utf8"));
    assert.notEqual(
      health.instance.pid,
      before.appPid,
      "새 앱 프로세스여야 한다",
    );
    let live;
    let saved;
    const deadline = Date.now() + 30_000;
    do {
      live = await invoke("get_terminal_session_attributions");
      saved = savedSessions(await invoke("load_settings"));
      if (
        Object.entries(before.sessions).every(
          ([id, session]) =>
            live[id]?.state === "identified" &&
            live[id]?.sessionId === session &&
            saved[id] === session,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    for (const [id, session] of Object.entries(before.sessions)) {
      assert.equal(live[id]?.state, "identified", id);
      assert.equal(live[id]?.sessionId, session, id);
      assert.equal(saved[id], session, id);
    }
    console.log(
      JSON.stringify(
        {
          previousPid: before.appPid,
          appPid: health.instance.pid,
          restored: saved,
        },
        null,
        2,
      ),
    );
  }
} finally {
  page.close();
}
