// verify-worktree-view.mjs가 만든 workspace를 dev의 활성 대상으로 둔 채
// GUI를 종료·재시작한 뒤 실행한다. 수동 새로고침 없이 재연결 경고 회복을 확인한다.
// dev WebView의 CDP는 9342이며 release에는 접근하지 않는다.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(repo, ".screenshots/worktree-view");
const fixture = JSON.parse(
  await readFile(path.join(artifacts, "report.json"), "utf8"),
);
const apiRoot = "http://127.0.0.1:19281/api/v1";
async function until(read, accept, label) {
  const deadline = Date.now() + 60_000;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
async function api(route) {
  const response = await fetch(apiRoot + route);
  const result = await response.json();
  assert.ok(response.ok && result.success !== false, JSON.stringify(result));
  return result;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(repo).toLowerCase(),
);
const browser = await chromium.connectOverCDP(
  process.env.LAYMUX_CDP_URL || "http://127.0.0.1:9342",
);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((item) =>
      /^http:\/\/(localhost|127\.0\.0\.1):1420\/$/.test(item.url()),
    );
  assert.ok(page, "dev WebView");
  const current = (await api("/workspaces/active")).workspace;
  assert.equal(
    current.id,
    fixture.workspaceId,
    "기존 검증 workspace를 자동 복원해야 한다",
  );
  const pane = page.locator(
    `[data-testid="view-worktree"][data-pane-id="${fixture.paneId}"]`,
  );
  await pane.waitFor();
  const terminals = await until(
    () => api("/terminals"),
    (result) =>
      result.instances.some(
        (item) => item.workspaceId === fixture.workspaceId && item.sessionReady,
      ),
    "기존 PTY 재연결 준비",
  );
  const listing = (
    await api(
      `/worktrees?workingDir=${encodeURIComponent(fixture.fixture.main)}`,
    )
  ).data;
  assert.deepEqual(
    listing.usageWarnings,
    [],
    "재연결이 완료된 backend에 실제 관측 실패가 없어야 한다",
  );
  const observed = await until(
    () =>
      pane.evaluate((view) => ({
        busy: view.getAttribute("aria-busy") === "true",
        warnings: [
          ...view.querySelectorAll(
            '[data-testid="worktree-list"] > .worktree-warning',
          ),
        ].map((item) => item.textContent),
        errors: [...view.querySelectorAll('[role="alert"]')].map(
          (item) => item.textContent,
        ),
        rows: view.querySelectorAll("[data-worktree-path]").length,
      })),
    (state) =>
      !state.busy &&
      state.errors.length === 0 &&
      state.warnings.length === 0 &&
      state.rows === listing.worktrees.length,
    "새로고침 없이 실제 화면의 오래된 재연결 경고 해소",
  );
  const inUse = listing.worktrees.find((entry) => entry.branch === "in-use");
  assert.ok(
    inUse?.usage.some((usage) => usage.kind === "live"),
    "복원 PTY의 실제 사용 연결을 유지해야 한다",
  );
  await page.screenshot({
    path: path.join(artifacts, "recovery-after-restart.png"),
  });
  const result = {
    pid: health.instance.pid,
    workspaceId: current.id,
    manualRefresh: false,
    restored: terminals.instances
      .filter((item) => item.workspaceId === fixture.workspaceId)
      .map((item) => ({
        id: item.id,
        ready: item.sessionReady,
        generation: item.generation,
      })),
    observed,
    results: [
      "GUI 재시작 뒤 실제 PTY 재연결",
      "수동 새로고침 없이 API와 화면의 경고 일치",
      "복원된 PTY의 live 사용 정보 유지",
    ],
  };
  await writeFile(
    path.join(artifacts, "recovery-report.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
