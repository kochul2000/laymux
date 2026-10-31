// 실제 빈 Codex가 실행 중인 격리 dev에서만 실행한다. 모델 요청·앱 종료는 하지 않는다.
// LAYMUX_CODEX_WORKSPACE, LAYMUX_CDP_URL(기본 9342), LAYMUX_DEV_URL(기본 1420).
// node scripts/tests/codex-empty-close.e2e.mjs [--expect-failure] [--delay-ms=26000]
import assert from "node:assert/strict";
import path from "node:path";
import { connectDevPage } from "./dev-cdp.mjs";

const workspace = process.env.LAYMUX_CODEX_WORKSPACE;
assert.ok(workspace, "격리 workspace ID를 지정한다");
const delayMs = Number(
  process.argv.find((arg) => arg.startsWith("--delay-ms="))?.split("=")[1] ??
    26000,
);
assert.ok(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 35000);
const expectFailure = process.argv.includes("--expect-failure");
const health = await (
  await fetch("http://127.0.0.1:19281/api/v1/health")
).json();
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  health.instance.worktreeRoot.toLowerCase(),
  path.resolve(".").toLowerCase(),
);
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
  process.env.LAYMUX_DEV_URL || "http://localhost:1420",
);
try {
  const result = await page.evaluate(
    async ({ workspace, delayMs }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { useWorkspaceStore } =
        await import("/src/stores/workspace-store.ts");
      const spaces = useWorkspaceStore.getState().workspaces;
      if (
        !spaces.length ||
        !spaces.every((w) => w.name.startsWith("laymux-codex-empty"))
      )
        throw Error("격리 검증 workspace만 허용한다");
      const target = spaces.find((w) => w.id === workspace);
      if (!target) throw Error("검증 workspace가 없다");
      const ids = target.panes.flatMap((p) =>
        p.layers
          .filter((l) => l.view.type === "TerminalView")
          .map((l) => `terminal-${l.id}`),
      );
      const { flushSessionCheckpoint } =
        await import("/src/lib/persist-session.ts");
      const { withCodexStatusCheckpoint } =
        await import("/src/lib/codex-status-probe.ts");
      const before = await invoke("get_terminal_session_attributions");
      const unresolved = ids.filter(
        (id) => before[id]?.state === "activeButUnidentified",
      );
      if (!unresolved.length)
        throw Error("읽기만으로 식별되지 않는 빈 Codex가 필요하다");
      let unverifiedError;
      try {
        await flushSessionCheckpoint({
          reason: "close",
          requireConclusive: true,
        });
      } catch (error) {
        unverifiedError = String(error);
      }
      if (!unverifiedError?.includes("Session attribution is not conclusive"))
        throw Error("미확인 귀속의 기존 차단이 유지되어야 한다");
      await invoke("begin_app_close");
      const started = performance.now();
      let saved, error, disk, sealedInputError;
      try {
        saved = await withCodexStatusCheckpoint(true, undefined, async () => {
          const acquiring = await invoke("get_terminal_session_attributions");
          for (const id of unresolved) {
            if (acquiring[id]?.state !== "fresh")
              throw Error(
                `빈 대화 확인 실패: ${id} ${JSON.stringify(acquiring[id])}`,
              );
          }
          // 확인 성공 뒤 저장 지연만 유발한다. 실제 proof·조회·DB 저장은 그대로다.
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          try {
            await invoke("write_terminal_input", {
              id: unresolved[0],
              text: "blocked-during-empty-close",
              submit: false,
            });
          } catch (error) {
            sealedInputError = String(error);
          }
          if (!sealedInputError) throw Error("저장 지연 중 입력 차단이 풀렸다");
          return await flushSessionCheckpoint({
            reason: "close",
            requireConclusive: true,
          });
        });
        disk = await invoke("load_settings");
      } catch (caught) {
        error = String(caught);
      } finally {
        await invoke("cancel_app_close");
      }
      return {
        ids,
        unresolved,
        before,
        unverifiedError,
        delayMs,
        saved,
        error,
        sealedInputError,
        disk: disk?.workspaces,
        ms: Math.round(performance.now() - started),
      };
    },
    { workspace, delayMs },
  );
  console.log(
    JSON.stringify({ instance: health.instance, ...result }, null, 2),
  );
  if (expectFailure) {
    assert.match(
      result.error ?? "",
      /Session attribution is not conclusive.*activeButUnidentified/,
    );
    assert.equal(result.saved, undefined);
  } else {
    assert.equal(result.error, undefined);
    assert.equal(result.saved.needsRetry, false);
    for (const id of result.unresolved) {
      assert.equal(
        result.saved.coverage.find((c) => c.terminalId === id)?.state,
        "fresh",
      );
      const layer = result.disk
        .flatMap((w) =>
          w.panes.flatMap((p) => p.layers ?? [{ id: p.id, view: p.view }]),
        )
        .find((l) => `terminal-${l.id}` === id);
      assert.equal(layer.view.lastAgentFresh, "codex");
      assert.equal(layer.view.lastCodexSession, undefined);
    }
  }
} finally {
  page.close();
}
