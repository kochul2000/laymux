// 격리 dev의 저장 완료 체크포인트 재사용과 입력 후 무효화를 검증한다.
import assert from "node:assert/strict";
import path from "node:path";
import { connectDevPage } from "./dev-cdp.mjs";

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
);
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9229",
  process.env.LAYMUX_DEV_URL || "http://localhost:1420",
);
try {
  const result = await page.evaluate(async () => {
    const { flushSessionCheckpoint, getReusableSessionCheckpointCommit } =
      await import("/src/lib/persist-session.ts");
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await flushSessionCheckpoint({ reason: "mutation" });
    const committed = getReusableSessionCheckpointCommit();
    if (!committed?.receiptToken)
      throw new Error("completed checkpoint has no reusable receipt");
    const started = performance.now();
    const reused = await invoke("begin_codex_status_checkpoint", {
      committedReceiptToken: committed.receiptToken,
    });
    try {
      if (!reused.reusedCheckpoint || reused.targets.length)
        throw new Error("unchanged checkpoint was not reused");
    } finally {
      await invoke("finish_codex_status_checkpoint", { token: reused.token });
    }
    const ms = Math.round(performance.now() - started);
    const terminal = committed.coverage.find(
      (entry) => entry.state === "identified" && entry.provider === "codex",
    );
    if (!terminal) throw new Error("fixture needs an identified Codex pane");
    await invoke("write_terminal_input", {
      id: terminal.terminalId,
      text: "draft-after-saved-checkpoint",
      submit: false,
    });
    const changed = await invoke("begin_codex_status_checkpoint", {
      committedReceiptToken: committed.receiptToken,
    });
    try {
      if (changed.reusedCheckpoint)
        throw new Error("human input did not invalidate receipt");
    } finally {
      await invoke("finish_codex_status_checkpoint", { token: changed.token });
    }
    await flushSessionCheckpoint({ reason: "mutation" });
    if (!getReusableSessionCheckpointCommit()?.receiptToken)
      throw new Error("refresh did not commit a receipt");
    return {
      reusedCheckpoint: true,
      beginMs: ms,
      inputInvalidatedReceipt: true,
      coverage: committed.coverage,
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  page.close();
}
