// 별도 APPDATA/LOCALAPPDATA와 기본 셸 하나로 실행한 격리 dev 전용.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectDevPage } from "./dev-cdp.mjs";

const root = path.resolve(".");
const fixture = path.join(root, ".tmp");
const discovery = JSON.parse(
  readFileSync(
    path.join(fixture, "review-profile/laymux-dev/automation.json"),
    "utf8",
  ),
);
const health = await (
  await fetch("http://127.0.0.1:19281/api/v1/health")
).json();
assert.equal(discovery.port, 19281);
assert.equal(discovery.pid, health.instance.pid);
assert.equal(health.instance.buildKind, "dev");
assert.equal(health.instance.worktreeRoot.toLowerCase(), root.toLowerCase());
let db;
const page = await connectDevPage(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9230",
  process.env.LAYMUX_DEV_URL || "http://localhost:1420",
);
try {
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const { flushSessionCheckpoint } =
      await import("/src/lib/persist-session.ts");
    const { onSessionCheckpointRequested } =
      await import("/src/lib/tauri-api.ts");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 기동 시 제목/workspace catch-up이 끝난 뒤 새 입력 없이 검사한다.
    await sleep(17000);
    const live = await invoke("get_terminal_session_attributions");
    const entries = Object.entries(live);
    if (entries.length !== 1 || entries[0][1].state !== "noAgent")
      throw new Error(
        "기본 셸 하나이며 실행 중인 agent가 없는 fixture가 필요하다",
      );
    await flushSessionCheckpoint({ reason: "mutation" });
    const snapshot = await invoke("load_session_checkpoint");
    const requests = [];
    const stop = await onSessionCheckpointRequested((request) =>
      requests.push(request),
    );
    try {
      const started = performance.now();
      const partial = await invoke("save_session_checkpoint", {
        snapshot: {
          ...snapshot,
          coverage: entries.map(([terminalId, attribution]) => ({
            terminalId,
            generation: attribution.generation,
            state: "unknown",
          })),
        },
      });
      if (!partial.needsRetry) throw new Error("부분 commit 재현 실패");
      while (performance.now() - started < 10000) {
        const saved = await invoke("load_session_checkpoint");
        if (
          requests.length &&
          saved.coverage.length === entries.length &&
          saved.coverage.every((item) => item.state === "noAgent")
        ) {
          const native = requests[0];
          if (native.reason !== "completion" || native.requireConclusive)
            throw new Error("native의 일반 재시도 요청이어야 한다");
          return {
            partialRevision: partial.revision,
            recoveredWithoutNewIdentityHint: true,
            elapsedMs: Math.round(performance.now() - started),
            requestCount: requests.length,
          };
        }
        await sleep(25);
      }
      throw new Error("UI 부분 저장 뒤 native worker가 회복하지 않았다");
    } finally {
      stop();
    }
  });
  db = new DatabaseSync(
    path.join(fixture, "review-local/laymux-dev/state.db"),
    { readOnly: true },
  );
  const metadata = db
    .prepare("SELECT session_revision,needs_retry FROM state_meta WHERE id=1")
    .get();
  assert.ok(metadata.session_revision > result.partialRevision);
  assert.equal(metadata.needs_retry, 0);
  console.log(
    JSON.stringify({ ...result, confirmedRevision: metadata.session_revision }),
  );
} finally {
  db?.close();
  page.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
