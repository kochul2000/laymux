// Dev-only companion to agent-activity-recovery.e2e.mjs setup/quiet-exit.
// Real hook helpers, process ancestry, birth times and installed temp roots.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ui/node_modules/playwright-core/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, ".screenshots/agent-state-20261027/dev-e2e");
const contextPath = path.join(artifacts, "context.json");
const context = JSON.parse(await readFile(contextPath, "utf8"));
const phase = process.argv[2] ?? "prepare";
const base = "http://127.0.0.1:19281/api/v1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, data, method = data ? "POST" : "GET") {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
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
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
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
assert.ok(page);
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const states = () =>
  invoke("get_agent_hook_states", { providers: ["claude", "codex"] });
const own = async () =>
  (await api("/terminals")).instances.filter((t) =>
    context.targets.some((target) => target.id === t.id),
  );
const send = async (command) => {
  for (const target of context.targets)
    await api(`/terminals/${target.id}/write`, { data: `${command}\r` });
};
const allBound = (values) =>
  context.targets.every(
    (t) =>
      values[t.id]?.sessionId === t.sessionId &&
      values[t.id]?.provider === t.provider.toLowerCase(),
  );
try {
  if (phase === "prepare") {
    if (process.argv.includes("--isolated")) {
      // The caller launched a fresh, test-owned APPDATA/LOCALAPPDATA profile.
      // Its default shell must not contribute an unrelated fallback scan.
      await api("/workspaces/active", { id: context.originalWorkspace });
      const panes = (await api("/workspaces/active")).workspace.panes;
      for (let index = 0; index < panes.length; index++)
        await api(`/panes/${index}/view`, { type: "EmptyView" }, "PUT");
      await api("/workspaces/active", { id: context.workspace });
    }
    const settings = await invoke("load_settings");
    context.hookModes ??= {
      claude: settings.claude.stateDetection,
      codex: settings.codex.stateDetection,
    };
    await writeFile(contextPath, JSON.stringify(context, null, 2));
    const distro = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        String.raw`$base='HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss'; $id=(Get-ItemProperty -LiteralPath $base).DefaultDistribution; (Get-ItemProperty -LiteralPath (Join-Path $base $id)).DistributionName`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    assert.ok(distro);
    for (const target of context.targets) {
      const result = await invoke("manage_agent_hooks", {
        request: {
          provider: target.provider.toLowerCase(),
          operation: "install",
          configDir: target.directory,
          distro: target.environment === "WSL" ? distro : null,
        },
      });
      assert.equal(result.installed, true);
    }
    await page.evaluate(async () => {
      const { useSettingsStore } =
        await import("/src/stores/settings-store.ts");
      useSettingsStore.getState().setClaude({ stateDetection: "hooks" });
      useSettingsStore.getState().setCodex({ stateDetection: "hooks" });
    });
    await send("hook-start");
    const snapshots = await until(
      states,
      allBound,
      "Windows/WSL Codex/Claude exact hook binding",
    );
    await writeFile(
      path.join(artifacts, "hook-bindings.json"),
      JSON.stringify(snapshots, null, 2),
    );
    console.log(
      JSON.stringify({ phase, bound: Object.keys(snapshots).length }),
    );
  } else if (phase === "healthy") {
    assert.ok(allBound(await states()));
    await send("hook-running");
    await until(
      states,
      (values) =>
        allBound(values) &&
        context.targets.every((t) => values[t.id].state === "running"),
      "running hooks",
    );
    await sleep(10000);
    const initial = await states();
    await sleep(7000);
    const cached = await states();
    for (const target of context.targets)
      assert.equal(
        cached[target.id].verifiedAtMs,
        initial[target.id].verifiedAtMs,
        "cached reads must not renew proof time",
      );
    const before = await api("/dev/activity-metrics");
    const samples = [];
    const deadline = Date.now() + 240000;
    let nextEvent = 0;
    while (Date.now() < deadline) {
      if (Date.now() >= nextEvent) {
        await send("hook-heartbeat");
        nextEvent = Date.now() + 20000;
      }
      const values = await own();
      const snapshots = await states();
      assert.ok(allBound(snapshots));
      for (const target of context.targets)
        assert.equal(
          values.find((v) => v.id === target.id)?.activity?.name,
          target.provider,
        );
      samples.push({ at: Date.now(), snapshots, values });
      await sleep(5000);
    }
    const after = await api("/dev/activity-metrics");
    await writeFile(
      path.join(artifacts, "hook-healthy.json"),
      JSON.stringify({ before, after, samples }, null, 2),
    );
    assert.equal(
      after.nativeSnapshots,
      before.nativeSnapshots,
      "healthy hooks must not enumerate native processes",
    );
    assert.deepEqual(
      after.guestRuns,
      before.guestRuns,
      "healthy hooks must not start guest probes",
    );
    // After the unowned metadata retention window, verified roots must still
    // read new committed records without starting process observations.
    const codex = context.targets.filter(
      (target) => target.provider === "Codex",
    );
    for (const target of codex)
      await api(`/terminals/${target.id}/write`, { data: "busy\r" });
    await until(
      own,
      (values) =>
        codex.every(
          (target) =>
            values.find((v) => v.id === target.id)?.codexTurn?.state ===
            "running",
        ),
      "records after retention: running",
      10000,
    );
    for (const target of codex)
      await api(`/terminals/${target.id}/write`, { data: "done\r" });
    await send("hook-idle");
    const completed = await until(
      own,
      (values) =>
        codex.every(
          (target) =>
            values.find((v) => v.id === target.id)?.codexTurn?.state ===
            "completed",
        ),
      "records after retention: completion",
      10000,
    );
    const finalMetrics = await api("/dev/activity-metrics");
    assert.equal(finalMetrics.nativeSnapshots, after.nativeSnapshots);
    assert.deepEqual(finalMetrics.guestRuns, after.guestRuns);
    await writeFile(
      path.join(artifacts, "hook-retained-records.json"),
      JSON.stringify({ completed, finalMetrics }, null, 2),
    );
    console.log(
      JSON.stringify({
        phase,
        samples: samples.length,
        nativeRuns: 0,
        guestRuns: 0,
        recordsAfterRetention: true,
      }),
    );
  } else if (phase === "shared-server") {
    const target = context.targets.find(
      (t) => t.environment === "Windows" && t.provider === "Codex",
    );
    const actor = spawn(
      path.join(artifacts, "codex.exe"),
      [
        "app-server",
        target.sessionId,
        path.join(target.directory, "shared-server-fixture"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...process.env,
          LX_AUTOMATION_PORT: "19281",
          LX_TERMINAL_ID: "",
          LX_AGENT_HOOK_TOKEN: "",
        },
      },
    );
    try {
      assert.ok(actor.pid);
      const birth = Number(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `([DateTimeOffset](Get-Process -Id ${actor.pid}).StartTime).ToUnixTimeSeconds()`,
          ],
          { encoding: "utf8", windowsHide: true },
        ).trim(),
      );
      assert.ok(Number.isSafeInteger(birth));
      const event = () => ({
        terminalId: "historical-shared-server-pane",
        token: "historical-token",
        provider: "codex",
        sessionId: target.sessionId,
        event: "PostToolUse",
        source: null,
        transcriptPath: null,
        cwd: null,
        agentId: null,
        turnId: "fixture-turn",
        emittedAtMs: Date.now(),
        ancestors: [
          {
            pid: actor.pid,
            parentPid: process.pid,
            startTime: birth,
            name: "codex.exe",
            helper: true,
          },
        ],
        distro: null,
        configDir: target.directory,
        toolName: "fixture",
        notificationType: null,
      });
      await api(`/terminals/${target.id}/write`, { data: "busy\r" });
      await api("/agent-hooks/events", event());
      await until(
        states,
        (values) => values[target.id]?.state === "running",
        "shared producer with a separately proven TUI",
      );
      // Let a coalesced acquisition finish before measuring event-only renewal.
      await sleep(3000);
      const initial = await states();
      await sleep(7000);
      await api("/agent-hooks/events", event());
      const later = await states();
      assert.equal(
        later[target.id]?.verifiedAtMs,
        initial[target.id].verifiedAtMs,
        "server events cannot renew TUI presence",
      );
      // Keep the actual helper-role process alive while the four real TUI
      // fixtures exit, using the existing quiet-window and shell-return suite.
      const quiet = execFileSync(
        "node",
        [
          path.join(root, "scripts/tests/agent-activity-recovery.e2e.mjs"),
          "quiet-exit",
        ],
        { cwd: root, windowsHide: true, encoding: "utf8", timeout: 120000 },
      );
      await api("/agent-hooks/events", event());
      assert.equal((await states())[target.id], undefined);
      assert.equal(
        (await own()).find((v) => v.id === target.id)?.activity?.type,
        "shell",
      );
      const generation = (await own()).find(
        (v) => v.id === target.id,
      ).generation;
      await assert.rejects(
        invoke("begin_agent_clear", { id: target.id, generation }),
        /fresh live agent/,
      );
      await writeFile(
        path.join(artifacts, "hook-shared-server.json"),
        JSON.stringify({ initial, later, quiet, after: await own() }, null, 2),
      );
      console.log(
        JSON.stringify({
          phase,
          producerOutsidePty: true,
          presenceNotRenewed: true,
          shellNotPromoted: true,
        }),
      );
    } finally {
      actor.stdin.end("exit\n");
      await new Promise((resolve) => actor.once("exit", resolve));
    }
  } else if (phase === "cleanup") {
    await page.evaluate(async (modes) => {
      const { useSettingsStore } =
        await import("/src/stores/settings-store.ts");
      useSettingsStore
        .getState()
        .setClaude({ stateDetection: modes.claude ?? "heuristic" });
      useSettingsStore
        .getState()
        .setCodex({ stateDetection: modes.codex ?? "heuristic" });
    }, context.hookModes);
    for (const target of context.targets.filter(
      (t) => t.environment === "Windows" && t.provider === "Claude",
    )) {
      try {
        const owned = (
          await readFile(
            path.join(target.directory, "owned-session-path.txt"),
            "utf8",
          )
        ).trim();
        const record = JSON.parse(await readFile(owned, "utf8"));
        assert.equal(record.sessionId, target.sessionId);
        assert.equal(
          path.resolve(owned).toLowerCase(),
          path
            .resolve(
              process.env.USERPROFILE,
              ".claude/sessions",
              `${record.pid}.json`,
            )
            .toLowerCase(),
        );
        await unlink(owned);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    console.log(JSON.stringify({ phase, restored: true }));
  } else throw new Error(`Unknown phase: ${phase}`);
} catch (error) {
  await writeFile(
    path.join(artifacts, `hook-${phase}-failure.json`),
    JSON.stringify(
      {
        message: error.message,
        metrics: await api("/dev/activity-metrics"),
        connections: await api("/agent-hooks/connections"),
        states: await states(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
