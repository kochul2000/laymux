// dev 전용: 실제 프로세스/PTY/OSC/재판정/턴 기록을 통한 감지 회귀 검증.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";
import {
  activityIpc,
  verifyActivityRemote,
} from "./fixtures/activity-helpers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, ".screenshots/agent-state-20261027/dev-e2e");
const base = "http://127.0.0.1:19281/api/v1";
const phase = process.argv[2] ?? "setup";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + route, {
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
async function until(read, predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
await mkdir(artifacts, { recursive: true });
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(root).toLowerCase(),
);
assert.equal(
  health.instance.gitCommit,
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9342");
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith("http://localhost:1420/"));
assert.ok(page, "dev WebView가 필요합니다.");
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const all = async () => (await api("/terminals")).instances;
const contextFile = path.join(artifacts, "context.json");
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
let context;
try {
  if (phase === "setup") {
    const originalWorkspace = (await api("/workspaces/active")).workspace.id;
    const workspace = (
      await api("/workspaces", {
        name: "Activity 회귀 dev 검증",
        layoutId: "default-layout",
      })
    ).workspace.id;
    await api("/workspaces/active", { id: workspace });
    await api(
      "/panes/0/view",
      {
        type: "TerminalView",
        profile: "PowerShell",
        syncGroup: "none",
        cwdSend: false,
        cwdReceive: false,
      },
      "PUT",
    );
    await api("/panes/split", {
      paneIndex: 0,
      direction: "horizontal",
      profile: "PowerShell",
    });
    await api("/panes/split", {
      paneIndex: 0,
      direction: "vertical",
      profile: "WSL",
    });
    await api("/panes/split", {
      paneIndex: 1,
      direction: "vertical",
      profile: "WSL",
    });
    const panes = (await api("/workspaces/active")).workspace.panes;
    assert.equal(panes.length, 4);
    const binary = path.join(artifacts, "codex.exe");
    execFileSync(
      "rustc",
      [
        path.join(root, "scripts/tests/fixtures/activity-agent.rs"),
        "-o",
        binary,
      ],
      { windowsHide: true },
    );
    await copyFile(binary, path.join(artifacts, "claude.exe"));
    const windows = panes.filter((p) => p.view.profile === "PowerShell");
    const wsl = panes.filter((p) => p.view.profile === "WSL");
    assert.equal(windows.length, 2);
    assert.equal(wsl.length, 2);
    context = {
      originalWorkspace,
      workspace,
      initialPid: health.instance.pid,
      targets: [],
      checks: [],
    };
    for (const [environment, group] of [
      ["Windows", windows],
      ["WSL", wsl],
    ]) {
      for (const [index, provider] of ["Codex", "Claude"].entries()) {
        const pane = group[index],
          id = randomUUID();
        const directory =
          environment === "WSL"
            ? `/tmp/laymux-activity-${id}`
            : path.join(artifacts, id);
        const target = {
          id: pane.terminalId,
          provider,
          environment,
          sessionId: id,
          directory,
        };
        context.targets.push(target);
        await until(
          all,
          (values) => values.some((t) => t.id === target.id && t.sessionReady),
          "PTY 준비",
        );
        let command;
        if (environment === "Windows") {
          await mkdir(directory, { recursive: true });
          command = `$env:CODEX_HOME=${quote(directory)}; $env:CODEX_SQLITE_HOME=${quote(directory)}; & ${quote(path.join(artifacts, provider.toLowerCase() + ".exe"))} ${provider} ${id} ${quote(directory)}\r`;
        } else {
          const script = path
            .join(root, "scripts/tests/fixtures/activity-agent.py")
            .replaceAll("\\", "/")
            .replace(
              /^([A-Za-z]):/,
              (_, drive) => "/mnt/" + drive.toLowerCase(),
            );
          command = `HOME='${directory}' CODEX_HOME='${directory}' CODEX_SQLITE_HOME='${directory}' python3 '${script}' ${provider} ${id} '${directory}'\r`;
        }
        await api(`/terminals/${target.id}/write`, { data: command });
      }
    }
    await writeFile(contextFile, JSON.stringify(context, null, 2));
    await until(
      all,
      (values) =>
        context.targets.every((t) =>
          values.some((v) => v.id === t.id && v.activity?.name === t.provider),
        ),
      "네 프로세스 식별",
    );
    await until(
      all,
      (values) =>
        context.targets
          .filter((t) => t.provider === "Codex")
          .every((t) =>
            values.some(
              (v) =>
                v.id === t.id &&
                v.codexTurn?.sessionId === t.sessionId &&
                v.codexTurn?.state === "completed",
            ),
          ),
      "Codex live 제목과 기록 복구",
    );
    context.checks.push({
      phase,
      at: new Date().toISOString(),
      targets: context.targets,
    });
  } else {
    context = JSON.parse(await readFile(contextFile, "utf8"));
    const own = async () =>
      (await all()).filter((t) =>
        context.targets.some((target) => target.id === t.id),
      );
    const assertApps = (values) => {
      for (const target of context.targets)
        assert.equal(
          values.find((v) => v.id === target.id)?.activity?.name,
          target.provider,
          `${target.environment} ${target.provider}`,
        );
    };
    if (phase === "fault") {
      assertApps(await own());
      const { setDistro, originalDistro } = await activityIpc(
        root,
        artifacts,
        health.instance.pid,
      );
      for (const target of context.targets)
        await api(`/terminals/${target.id}/write`, { data: "flood\r" });
      const timeline = [];
      try {
        for (const target of context.targets.filter(
          (t) => t.environment === "WSL",
        ))
          setDistro(target, "LaymuxActivityUnavailableE2E");
        const deadline = Date.now() + 80000;
        let resetTitle = false;
        while (Date.now() < deadline) {
          if (!resetTitle && Date.now() > deadline - 50000) {
            for (const target of context.targets)
              await api(`/terminals/${target.id}/write`, { data: "title-reset\r" });
            await sleep(1000);
            assertApps(await own());
            // A real title reset legitimately invalidates the managed UUID.
            // Re-establish it, then evict its bytes again: after probe recovery
            // there will be no fresh title to rescue an erroneous exit cleanup.
            for (const target of context.targets) {
              await api(`/terminals/${target.id}/write`, { data: "restore-title\r" });
              await api(`/terminals/${target.id}/write`, { data: "flood\r" });
            }
            resetTitle = true;
          }
          const values = await own();
          assertApps(values);
          timeline.push({
            at: new Date().toISOString(),
            values: values.map((t) => ({
              id: t.id,
              activity: t.activity,
              sequence: t.activitySequence,
              task: t.task,
              codexTurn: t.codexTurn,
            })),
          });
          await sleep(2000);
        }
        const backend = (await api("/terminals/states")).states;
        for (const target of context.targets.filter(
          (t) => t.environment === "WSL",
        ))
          assert.equal(
            backend[target.id].activity.type,
            "unknown",
            "실제 guest 관측 실패가 주입돼야 합니다.",
          );
        assertApps(await own());
      } finally {
        for (const target of context.targets.filter(
          (t) => t.environment === "WSL",
        ))
          setDistro(target, originalDistro);
        await writeFile(
          path.join(artifacts, "fault-timeline.json"),
          JSON.stringify(timeline, null, 2),
        );
      }
      await until(
        own,
        (values) =>
          context.targets
            .filter((t) => t.provider === "Codex")
            .every((t) =>
              values.some(
                (v) =>
                  v.id === t.id &&
                  v.codexTurn?.sessionId === t.sessionId &&
                  v.codexTurn?.state === "completed",
              ),
            ),
        "새 제목 없이 Codex 대화와 턴 복구",
      );
      for (const target of context.targets.filter(
        (t) => t.provider === "Codex",
      ))
        await api(`/terminals/${target.id}/write`, { data: "busy\r" });
      await until(
        own,
        (values) =>
          context.targets
            .filter((t) => t.provider === "Codex")
            .every((t) =>
              values.some(
                (v) => v.id === t.id && v.codexTurn?.state === "running",
              ),
            ),
        "무출력 busy",
      );
      context.beforeReattach = await own();
      context.inventoryBefore = (
        await api("/pty-sessions")
      ).data.sessions.filter((entry) =>
        context.targets.some((target) => target.id === entry.terminalId),
      );
      assert.equal(
        context.inventoryBefore.length,
        context.targets.length,
        "모든 검증 PTY의 재부착 기준",
      );
      await api("/dev/update-handoff", { mode: "prepare" });
      context.checks.push({
        phase,
        at: new Date().toISOString(),
        samples: timeline.length,
      });
    } else if (phase === "quiet-exit") {
      assertApps(await own());
      // Let corrections requested by the preceding fault/entry events settle
      // before measuring a window with no further observations.
      await sleep(8000);
      await page.evaluate(async () => {
        const { onTaskStateRefresh } = await import("/src/lib/task-state-refresh.ts");
        window.__activityRefreshes = [];
        window.__stopActivityRefresh = onTaskStateRefresh((ids) =>
          window.__activityRefreshes.push({ at: Date.now(), ids }),
        );
      });
      const quiet = [];
      const deadline = Date.now() + 65000;
      while (Date.now() < deadline) {
        const values = await own();
        assertApps(values);
        quiet.push({ at: Date.now(), values });
        await sleep(2000);
      }
      const refreshes = await page.evaluate(() => {
        window.__stopActivityRefresh();
        return window.__activityRefreshes;
      });
      assert.deepEqual(refreshes, [], "60초 경계에도 전체 task 복구 요청이 없어야 합니다.");
      const first = quiet[0].values;
      for (const values of quiet.slice(1).map((sample) => sample.values)) {
        for (const target of context.targets) {
          assert.equal(values.find((v) => v.id === target.id).activitySequence,
            first.find((v) => v.id === target.id).activitySequence,
            "변경 없는 activity를 시간 경과만으로 재발행하지 않아야 합니다.");
        }
      }
      const exits = [];
      for (const target of context.targets) {
        const started = Date.now();
        await api(`/terminals/${target.id}/write`, { data: "exit\r" });
        await until(own, (values) => values.find((v) => v.id === target.id)?.activity?.type === "shell",
          `${target.environment} ${target.provider} shell 복귀`, 8000);
        const elapsedMs = Date.now() - started;
        assert.ok(elapsedMs < 8000, "종료는 grace 만료를 기다리지 않아야 합니다.");
        exits.push({ ...target, elapsedMs });
      }
      await writeFile(path.join(artifacts, "quiet-exit.json"), JSON.stringify({ quiet, refreshes, exits }, null, 2));
      const screenshot = await api("/screenshot", {});
      await writeFile(path.join(artifacts, "shell-return.png"), Buffer.from(screenshot.dataUrl.split(",")[1], "base64"));
      context.checks.push({ phase, at: new Date().toISOString(), exits });
    } else if (phase === "prepare") {
      assertApps(await own());
      for (const target of context.targets.filter(
        (t) => t.provider === "Codex",
      ))
        await api(`/terminals/${target.id}/write`, { data: "busy\r" });
      await until(
        own,
        (values) =>
          context.targets
            .filter((t) => t.provider === "Codex")
            .every((t) =>
              values.some(
                (v) => v.id === t.id && v.codexTurn?.state === "running",
              ),
            ),
        "무출력 busy",
      );
      context.beforeReattach = await own();
      context.inventoryBefore = (
        await api("/pty-sessions")
      ).data.sessions.filter((entry) =>
        context.targets.some((target) => target.id === entry.terminalId),
      );
      assert.equal(
        context.inventoryBefore.length,
        context.targets.length,
        "모든 검증 PTY의 재부착 기준",
      );
      await api("/dev/update-handoff", { mode: "prepare" });
      context.checks.push({ phase, at: new Date().toISOString() });
    } else if (phase === "reattach") {
      assert.notEqual(
        health.instance.pid,
        context.initialPid,
        "GUI가 실제 재기동돼야 합니다.",
      );
      await api("/workspaces/active", { id: context.workspace });
      await until(
        own,
        (values) =>
          context.targets.every((t) =>
            values.some(
              (v) => v.id === t.id && v.activity?.name === t.provider,
            ),
          ),
        "무출력 재부착 후 앱 식별",
      );
      await until(
        own,
        (values) =>
          context.targets
            .filter((t) => t.provider === "Codex")
            .every((t) =>
              values.some(
                (v) =>
                  v.id === t.id &&
                  v.codexTurn?.sessionId === t.sessionId &&
                  v.codexTurn?.state === "running",
              ),
            ),
        "재부착 후 Codex busy",
      );
      const after = await own();
      const inventoryAfter = (await api("/pty-sessions")).data.sessions;
      for (const before of context.inventoryBefore) {
        const current = inventoryAfter.find(
          (entry) => entry.terminalId === before.terminalId,
        );
        assert.ok(current, "재부착된 PTY");
        assert.equal(
          current.sessionId,
          before.sessionId,
          "동일 daemon session",
        );
        assert.equal(current.childPid, before.childPid, "동일 셸 프로세스");
        assert.ok(
          current.attachEpoch > before.attachEpoch,
          "새 GUI의 실제 재부착",
        );
      }
      const quiet = [];
      const quietUntil = Date.now() + 65000;
      while (Date.now() < quietUntil) {
        const values = await own();
        assertApps(values);
        for (const target of context.targets.filter(
          (t) => t.provider === "Codex",
        ))
          assert.equal(
            values.find((v) => v.id === target.id)?.codexTurn?.state,
            "running",
          );
        quiet.push({
          at: new Date().toISOString(),
          values: values.map((v) => ({
            id: v.id,
            activity: v.activity,
            sequence: v.activitySequence,
            turn: v.codexTurn,
          })),
        });
        await sleep(2000);
      }
      await writeFile(
        path.join(artifacts, "reattach-quiet-timeline.json"),
        JSON.stringify(quiet, null, 2),
      );
      for (const target of context.targets.filter(
        (t) => t.provider === "Codex",
      ))
        await api(`/terminals/${target.id}/write`, { data: "done\r" });
      await until(
        own,
        (values) =>
          context.targets
            .filter((t) => t.provider === "Codex")
            .every((t) =>
              values.some(
                (v) => v.id === t.id && v.codexTurn?.state === "completed",
              ),
            ),
        "busy → completed",
      );
      const screenshot = await api("/screenshot", {});
      await writeFile(
        path.join(artifacts, "reattach.png"),
        Buffer.from(screenshot.dataUrl.split(",")[1], "base64"),
      );
      for (const target of context.targets)
        await api(`/terminals/${target.id}/write`, { data: "exit\r" });
      await until(
        own,
        (values) =>
          context.targets.every((t) =>
            values.some((v) => v.id === t.id && v.activity?.type === "shell"),
          ),
        "실제 종료 후 shell",
      );
      context.checks.push({
        phase,
        at: new Date().toISOString(),
        beforeExit: after,
      });
    } else if (phase === "unknown") {
      const target = context.targets.find((t) => t.environment === "Windows");
      const binary = path.join(artifacts, "unknown.exe");
      execFileSync("rustc", [path.join(root, "scripts/tests/fixtures/activity-agent.rs"), "-o", binary], { windowsHide: true });
      const started = `$env:CODEX_HOME=${quote(target.directory)}; & ${quote(binary)} Unknown ${randomUUID()} ${quote(target.directory)}\r`;
      await api(`/terminals/${target.id}/write`, { data: started });
      await sleep(1000);
      await api(`/terminals/${target.id}/write`, { data: "flood\r" });
      await until(own, (values) => values.find((v) => v.id === target.id)?.activity?.type === "unknown", "lifecycle 근거 없는 프로세스는 unknown");
      assert.equal((await api("/terminals/states")).states[target.id].activity.type, "unknown");
      const pane = (await api("/workspaces/active")).workspace.panes.find((p) => p.terminalId === target.id);
      const clear = await api(`/panes/${pane.id}/clear`, {});
      assert.ok(clear.skipped.some((s) => s.terminalId === target.id && s.reason === "stateUnknown"), JSON.stringify(clear));
      assert.deepEqual(clear.cleared, []);
      const beforeDrift = await own();
      await page.evaluate(async (id) => {
        const { useTerminalStore } = await import("/src/stores/terminal-store.ts");
        window.__activityDrift = [];
        window.__stopActivityDrift = useTerminalStore.subscribe((state) => {
          const instance = state.instances.find((i) => i.id === id);
          window.__activityDrift.push(instance?.activity);
        });
      }, target.id);
      const driftStarted = Date.now();
      await api(`/terminals/${target.id}/write`, { data: "stale-title\r" });
      await until(own, (values) => {
        const current = values.find((v) => v.id === target.id);
        return current?.activity?.type === "unknown" && current.activitySequence > beforeDrift.find((v) => v.id === target.id).activitySequence;
      }, "backend 판정이 같아도 늦은 live 제목을 해당 pane만 보정", 8000);
      const correctionMs = Date.now() - driftStarted;
      const drift = await page.evaluate(() => {
        window.__stopActivityDrift();
        return window.__activityDrift;
      });
      assert.ok(drift.some((activity) => activity?.name === "Claude"), "실제 live 제목이 UI를 잘못 바꾼 뒤 보정돼야 합니다.");
      for (const current of await own()) {
        if (current.id !== target.id)
          assert.equal(current.activitySequence, beforeDrift.find((v) => v.id === current.id).activitySequence, "다른 pane 전체 재발행 금지");
      }
      await page.evaluate(() => {
        for (const button of document.querySelectorAll("button"))
          if (button.textContent.trim() === "나중에") button.click();
      });
      const values = await own();
      assert.equal(values.find((v) => v.id === target.id).selectorDisplay.activity.label, "unknown");
      const screenshot = await api("/screenshot", {});
      await writeFile(path.join(artifacts, "unknown.png"), Buffer.from(screenshot.dataUrl.split(",")[1], "base64"));
      await writeFile(path.join(artifacts, "unknown.json"), JSON.stringify({ values, clear, drift, correctionMs }, null, 2));
      await api(`/terminals/${target.id}/write`, { data: "exit\r" });
      await until(own, (values) => values.find((v) => v.id === target.id)?.activity?.type === "shell", "미관측 프로세스 종료 후 셸 확인");
      context.checks.push({ phase, at: new Date().toISOString() });
    } else if (phase === "remote") {
      assertApps(await own());
      const rows = await verifyActivityRemote(
        invoke,
        context.targets,
        artifacts,
      );
      context.checks.push({ phase, at: new Date().toISOString(), rows });
    } else if (phase === "cleanup") {
      await api("/workspaces/active", { id: context.originalWorkspace });
      await api(`/workspaces/${context.workspace}`, undefined, "DELETE");
      context.checks.push({ phase, at: new Date().toISOString() });
    } else throw new Error("알 수 없는 단계");
  }
  await writeFile(contextFile, JSON.stringify(context, null, 2));
  console.log(
    JSON.stringify(
      {
        phase,
        workspace: context.workspace,
        checks: context.checks.map((c) => ({
          phase: c.phase,
          at: c.at,
          samples: c.samples,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
