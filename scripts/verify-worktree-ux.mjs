// 네이티브 실기 fixture로 이동·필터·좁은 pane 및 실제 저장소 표시를 확인한다.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(repo, ".screenshots/worktree-view");
const report = JSON.parse(
  await readFile(path.join(artifacts, "report.json"), "utf8"),
);
async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`http://127.0.0.1:19281/api/v1${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok && data.success !== false, JSON.stringify(data));
  return data;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(repo).toLowerCase(),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9342");
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((item) => item.url() === "http://localhost:1420/");
  assert.ok(page);
  const postpone = page.getByRole("button", { name: "나중에", exact: true });
  if (await postpone.isVisible()) await postpone.click();
  await api("/workspaces/active", { id: report.workspaceId });
  await api("/panes/layers/activate", { layerId: report.paneId });
  const view = page.locator(
    `[data-testid="view-worktree"][data-pane-id="${report.paneId}"]`,
  );
  await view.waitFor();
  await api("/ui/worktrees", { paneId: report.paneId, action: "refresh" });
  const settled = () =>
    page.waitForFunction(
      (id) => {
        const view = document.querySelector(
          `[data-testid="view-worktree"][data-pane-id="${id}"]`,
        );
        return (
          view?.querySelector("[data-worktree-path]") &&
          !view.textContent?.includes("내용 검사 중")
        );
      },
      report.paneId,
      { timeout: 90_000 },
    );
  await settled();
  await api("/ui/worktrees", {
    paneId: report.paneId,
    action: "filter",
    filter: "candidates",
  });
  const candidatePaths = await view
    .locator("[data-worktree-path]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-worktree-path")),
    );
  assert.equal(candidatePaths.length, 2);
  assert.ok(candidatePaths.some((tree) => tree.endsWith("/ready-for-review")));
  assert.ok(candidatePaths.every((tree) => !tree.endsWith("/in-use")));
  await page.screenshot({ path: path.join(artifacts, "candidates.png") });
  await api("/ui/worktrees", {
    paneId: report.paneId,
    action: "filter",
    filter: "all",
  });
  const inUse = report.fixture.paths["in-use"].replaceAll("\\", "/");
  await api("/ui/worktrees", {
    paneId: report.paneId,
    action: "select",
    path: inUse,
  });
  await view.getByTestId("worktree-detail-summary").waitFor();
  const usageButton = view
    .getByTestId("worktree-detail")
    .getByRole("button", { name: /실행 중/ });
  await usageButton.click();
  await view.waitFor({ state: "hidden" });
  await api("/panes/layers/activate", { layerId: report.paneId });
  await view.waitFor();
  await api("/ui/worktrees", {
    paneId: report.paneId,
    action: "select",
    path: inUse,
  });
  await view.getByTestId("worktree-detail-summary").waitFor();
  await view.getByTestId("worktree-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "live-usage.png") });
  await page.setViewportSize({ width: 800, height: 800 });
  await view.getByTestId("worktree-detail").scrollIntoViewIfNeeded();
  const bounds = await view.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
  await page.screenshot({ path: path.join(artifacts, "narrow-pane.png") });
  await page.setViewportSize({ width: 1200, height: 800 });
  await api("/ui/worktrees", { paneId: report.paneId, action: "refresh" });
  await settled();
  await view.locator("[data-worktree-path]").first().scrollIntoViewIfNeeded();
  const screenshot = await api("/screenshot", undefined, "POST");
  await page.screenshot({ path: path.join(artifacts, "overview.png") });
  const result = {
    results: [
      "정리 후보 2개와 사용 중 제외 확인",
      "사용 연결 버튼으로 실제 터미널 탭 이동",
      "폭 800 화면의 좁은 pane 수평 overflow 없음",
    ],
    bounds,
    screenshot,
  };
  await writeFile(
    path.join(artifacts, "ux-report.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
