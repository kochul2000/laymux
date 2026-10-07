// APPDATA/LOCALAPPDATA가 현재 worktree의 .tmp인 격리 dev에서만 실행한다.
// prepare 후 kill-dev.sh로 앱을 종료하고 같은 경로로 재기동해 verify한다.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectDevPage } from "./dev-cdp.mjs";

const [mode, resultFile = ".tmp/sqlite-restart.json"] = process.argv.slice(2);
assert.ok(["check", "prepare", "verify", "protected-db"].includes(mode));
const root = path.resolve(".");
const fixtureRoot = path.join(root, ".tmp") + path.sep;
const settingsFile = path.resolve(
  process.env.LAYMUX_SQLITE_SETTINGS || ".tmp/profile/laymux-dev/settings.json",
);
const databaseFile = path.resolve(
  process.env.LAYMUX_SQLITE_DATABASE || ".tmp/local/laymux-dev/state.db",
);
for (const file of [settingsFile, databaseFile, path.resolve(resultFile)])
  assert.ok(
    file.toLowerCase().startsWith(fixtureRoot.toLowerCase()),
    "파일은 현재 worktree의 격리 fixture에 한정한다",
  );
const workspace = process.env.LAYMUX_CODEX_WORKSPACE;
assert.ok(workspace?.startsWith("matrix-"));
const base = "http://127.0.0.1:19281/api/v1";
const health = await (await fetch(`${base}/health`)).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(health.instance.worktreeRoot.toLowerCase(), root.toLowerCase());
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9229",
  process.env.LAYMUX_DEV_URL || "http://localhost:1420",
);
const invoke = (command) =>
  page.evaluate(
    (command) => window.__TAURI_INTERNALS__.invoke(command),
    command,
  );
const sessions = (settings) =>
  Object.fromEntries(
    settings.workspaces
      .find((w) => w.id === workspace)
      .panes.flatMap((p) =>
        p.layers?.length ? p.layers : [{ id: p.id, view: p.view }],
      )
      .filter((p) => p.view.type === "TerminalView" && p.view.lastCodexSession)
      .map((p) => [`terminal-${p.id}`, p.view.lastCodexSession]),
  );
function assertPortable(value) {
  for (const key of [
    "workspaces",
    "docks",
    "workspaceDisplayOrder",
    "localUiState",
    "remote",
  ])
    assert.ok(!(key in value), key);
  const text = JSON.stringify(value);
  for (const key of [
    "lastCodexSession",
    "lastClaudeSession",
    "lastCwd",
    "commandLine",
    "startingDirectory",
    "configDir",
  ])
    assert.ok(!text.includes(`"${key}"`), key);
}
try {
  if (mode === "protected-db") {
    const before = readFileSync(databaseFile);
    const jsonBefore = readFileSync(settingsFile);
    const result = await invoke("load_settings_validated");
    assert.equal(result.status, "parse_error");
    assert.equal(result.storageKind, "localState");
    const state = await page.evaluate(async () => {
      const { flushSessionCheckpoint } =
        await import("/src/lib/persist-session.ts");
      let blocked = false;
      try {
        await flushSessionCheckpoint({ reason: "mutation" });
      } catch {
        blocked = true;
      }
      const dialog = document.querySelector('[role="dialog"]');
      return {
        blocked,
        text: dialog?.textContent,
        buttons: Array.from(dialog?.querySelectorAll("button") || []).map(
          (b) => b.textContent,
        ),
      };
    });
    assert.ok(state.blocked);
    assert.ok(state.text?.includes("state.db"));
    assert.ok(!state.buttons.some((text) => /초기화|Reset/i.test(text)));
    assert.deepEqual(readFileSync(databaseFile), before);
    assert.deepEqual(readFileSync(settingsFile), jsonBefore);
    console.log(
      JSON.stringify({
        protectedDatabase: true,
        writesBlocked: true,
        resetHidden: true,
      }),
    );
  } else {
    const terminals = (await (await fetch(`${base}/terminals`)).json())
      .instances;
    assert.ok(
      terminals.length && terminals.every((t) => t.workspaceId === workspace),
      "격리 fixture pane만 있어야 한다",
    );
    if (mode === "verify") {
      const before = JSON.parse(readFileSync(resultFile, "utf8"));
      assert.notEqual(health.instance.pid, before.pid);
      let live;
      const deadline = Date.now() + 45_000;
      do {
        live = await invoke("get_terminal_session_attributions");
        if (
          Object.entries(before.sessions).every(
            ([id, session]) =>
              live[id]?.state === "identified" &&
              live[id]?.sessionId === session,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      for (const [id, session] of Object.entries(before.sessions)) {
        assert.equal(live[id]?.state, "identified", id);
        assert.equal(live[id]?.sessionId, session, id);
      }
      assert.deepEqual(
        sessions(await invoke("load_settings")),
        before.sessions,
      );
      const restored = await page.evaluate(async () => {
        const { useWorkspaceStore } =
          await import("/src/stores/workspace-store.ts");
        const { useFileViewerStore } =
          await import("/src/stores/file-viewer-store.ts");
        const viewer = useFileViewerStore.getState();
        return {
          active: useWorkspaceStore.getState().activeWorkspaceId,
          viewer: {
            open: viewer.open,
            path: viewer.path,
            maximized: viewer.maximized,
          },
        };
      });
      assert.deepEqual(restored, before.ui);
      console.log(
        JSON.stringify({
          previousPid: before.pid,
          pid: health.instance.pid,
          restored: before.sessions,
          uiRestored: true,
        }),
      );
    } else {
      if (mode === "prepare") {
        await page.evaluate(
          async (file) => {
            const { useFileViewerStore } =
              await import("/src/stores/file-viewer-store.ts");
            useFileViewerStore
              .getState()
              .openFileViewer(file, { maximized: false });
          },
          path.join(root, ".tmp/project/restore.md"),
        );
      }
      const bytesBefore = readFileSync(settingsFile);
      const mtimeBefore = statSync(settingsFile).mtimeMs;
      const result = await page.evaluate(async (prepare) => {
        const {
          flushSessionCheckpoint,
          getReusableSessionCheckpointCommit,
          saveBeforeClose,
        } = await import("/src/lib/persist-session.ts");
        const { useWorkspaceStore } =
          await import("/src/stores/workspace-store.ts");
        const { useFileViewerStore } =
          await import("/src/stores/file-viewer-store.ts");
        const commit = await flushSessionCheckpoint({ reason: "mutation" });
        if (commit.needsRetry)
          throw new Error("fixture attribution is still pending");
        const viewer = useFileViewerStore.getState();
        const ui = {
          active: useWorkspaceStore.getState().activeWorkspaceId,
          viewer: {
            open: viewer.open,
            path: viewer.path,
            maximized: viewer.maximized,
          },
        };
        const receipt = getReusableSessionCheckpointCommit();
        if (!receipt?.receiptToken)
          throw new Error("fixture needs a reusable receipt");
        const started = performance.now();
        if (prepare) await saveBeforeClose();
        return {
          revision: commit.checkpointCommitId,
          ui,
          preparationMs: prepare
            ? Math.round(performance.now() - started)
            : undefined,
        };
      }, mode === "prepare");
      assert.deepEqual(readFileSync(settingsFile), bytesBefore);
      assert.equal(
        statSync(settingsFile).mtimeMs,
        mtimeBefore,
        "세션 저장은 settings.json을 다시 쓰지 않는다",
      );
      const portable = JSON.parse(readFileSync(settingsFile, "utf8"));
      const exported = await (await fetch(`${base}/settings/export`)).json();
      assertPortable(portable);
      assertPortable(exported.settings);
      assert.deepEqual(exported.settings, portable);
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      const meta = db
        .prepare(
          "SELECT session_revision,needs_retry FROM state_meta WHERE id=1",
        )
        .get();
      db.close();
      assert.ok(meta.session_revision >= result.revision);
      assert.equal(meta.needs_retry, 0);
      const snapshot = {
        pid: health.instance.pid,
        sessions: sessions(await invoke("load_settings")),
        ...result,
      };
      if (mode === "prepare")
        writeFileSync(resultFile, JSON.stringify(snapshot, null, 2) + "\n");
      console.log(
        JSON.stringify({
          ...snapshot,
          settingsUntouched: true,
          portableExport: true,
        }),
      );
    }
  }
} finally {
  page.close();
}
