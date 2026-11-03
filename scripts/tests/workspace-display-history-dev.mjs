// Dev(19281) 전용. prepare → kill-dev.sh --with-daemon → 재기동 → verify.
// 임시 표시 이력을 실제 checkpoint DB에 저장하고 미방문 workspace의 복원을 검증한다.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { connectDevPage } from "./dev-cdp.mjs";
import { api, until } from "./fixtures/graceful-close-dev.mjs";

const root = process.cwd();
const fixturePath = path.join(
  root,
  ".screenshots/workspace-display-history-fixture.json",
);
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  root.toLowerCase(),
);
const page = await connectDevPage(
  process.env.LAYMUX_DISPLAY_CDP ?? "http://127.0.0.1:19381",
  process.env.LAYMUX_DISPLAY_PAGE ?? "http://localhost:1421",
);
const mode = process.argv[2];
try {
  if (mode === "prepare") {
    const created = await api("/workspaces", {
      name: "Display-history-checkpoint",
    });
    const id = created.workspace.id;
    const fixture = await page.evaluate(
      async ({ id, profile }) => {
        const { useWorkspaceStore } =
          await import("/src/stores/workspace-store.ts");
        const { useTerminalDisplayStore } =
          await import("/src/stores/terminal-display-store.ts");
        const { flushSessionCheckpoint } =
          await import("/src/lib/persist-session.ts");
        const store = useWorkspaceStore.getState();
        const ws = store.workspaces.find((w) => w.id === id);
        const layer = ws.panes[0].layers[0];
        store.setPaneView(0, { type: "TerminalView", profile }, layer.id, id);
        const terminalId = `terminal-${layer.id}`;
        const context = {
          version: 1,
          profile,
          lastUserInput: "remember submitted input",
          lastUserInputAt: Date.now(),
          lastCommand: "codex --yolo",
          lastCommandAt: Date.now() - 60000,
          activity: { type: "interactiveApp", name: "Codex" },
          task: {
            source: "saved",
            taskId: "saved-turn",
            sequence: 1,
            state: "ended",
            result: "success",
            observation: "confirmed",
            observedAt: Date.now(),
            notificationId: 0,
          },
        };
        useTerminalDisplayStore.getState().setContext(terminalId, context);
        await flushSessionCheckpoint({ reason: "mutation" });
        return {
          id,
          terminalId,
          paneId: layer.id,
          originalActive: store.activeWorkspaceId,
          context,
        };
      },
      { id, profile: process.env.LAYMUX_DISPLAY_PROFILE ?? "PowerShell" },
    );
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
    console.log(JSON.stringify({ prepared: fixture.id, fixturePath }));
  } else if (mode === "verify") {
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
    const inspect = () =>
      page.evaluate(async ({ terminalId, paneId }) => {
        const { useTerminalStore } =
          await import("/src/stores/terminal-store.ts");
        const { useTerminalDisplayStore } =
          await import("/src/stores/terminal-display-store.ts");
        return {
          live: useTerminalStore
            .getState()
            .instances.find((i) => i.id === terminalId),
          history: useTerminalDisplayStore.getState().contexts[terminalId],
          row: document.querySelector(`[data-testid="pane-row-${paneId}"]`)
            ?.textContent,
        };
      }, fixture);
    const before = await until(async () => {
      const value = await inspect();
      return (
        value.history?.lastUserInput === fixture.context.lastUserInput && value
      );
    }, "disk display restore");
    assert.equal(
      before.live,
      undefined,
      "inactive workspace must remain unmounted",
    );
    assert.equal(before.history.activity.name, "Codex");
    assert.ok(
      before.row?.includes(fixture.context.lastUserInput),
      JSON.stringify(before),
    );
    const projected = (await api("/terminals")).instances.find(
      (i) => i.id === fixture.terminalId,
    );
    assert.equal(projected.task.state, "ended");
    assert.equal(projected.task.observation, "stale");
    const restoredScreenshot = (await api("/screenshot", {})).path;
    await api("/workspaces/active", { id: fixture.id });
    const entered = await until(
      async () => {
        const value = await inspect();
        return (
          value.live?.sessionReady &&
          value.live.activity?.type === "shell" &&
          value
        );
      },
      "workspace entry refresh",
      45000,
    );
    assert.equal(entered.live.activity.name, undefined);
    assert.equal(entered.live.lastUserInput, fixture.context.lastUserInput);
    assert.equal(entered.live.lastUserInputAt, fixture.context.lastUserInputAt);
    assert.ok(
      entered.row?.includes(fixture.context.lastUserInput),
      JSON.stringify(entered),
    );
    assert.notEqual(entered.live.task?.source, "saved");
    const enteredScreenshot = (await api("/screenshot", {})).path;
    console.log(
      JSON.stringify({
        restored: true,
        entryRefreshed: true,
        inputPreserved: true,
        restoredScreenshot,
        enteredScreenshot,
      }),
    );
  } else if (mode === "cleanup") {
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
    await api("/workspaces/active", { id: fixture.originalActive });
    await api(`/workspaces/${fixture.id}`, undefined, "DELETE");
    console.log(JSON.stringify({ removed: fixture.id }));
  } else throw new Error("prepare | verify | cleanup 중 하나를 지정하세요");
} finally {
  page.close();
}
