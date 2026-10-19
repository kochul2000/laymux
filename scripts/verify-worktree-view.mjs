// dev(19281)의 실제 Git 저장소·Tauri·WebView를 함께 검증한다.
// 실행: node scripts/verify-worktree-view.mjs --fixtures-only
//       node scripts/verify-worktree-view.mjs
// WebView2 CDP: http://127.0.0.1:9342. 검증 workspace와 fixture는 직접 확인하도록 남긴다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../ui/node_modules/playwright-core/index.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(repo, ".screenshots", "worktree-view");
await mkdir(artifacts, { recursive: true });
const fixtureFile = path.join(artifacts, "fixtures.json");
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function createFixtures() {
  const base = await mkdtemp(path.join(os.tmpdir(), "laymux-worktrees-"));
  const main = path.join(base, "main");
  await mkdir(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Laymux dev verification");
  git(main, "config", "user.email", "laymux-dev@example.invalid");
  git(main, "config", "commit.gpgsign", "false");
  await writeFile(
    path.join(main, "README.md"),
    "워크트리 실기 검증용 저장소\n",
  );
  await writeFile(path.join(main, ".gitignore"), "local-secret.txt\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "fixture");
  const paths = {};
  for (const name of [
    "done-api",
    "done-ui",
    "ready-for-review",
    "dirty",
    "untracked",
    "ignored",
    "locked",
    "in-use",
    "stale-head",
    "stale-files",
    "index-flags",
  ]) {
    paths[name] = path.join(base, name);
    git(main, "worktree", "add", "-b", name, paths[name]);
  }
  paths.detached = path.join(base, "detached");
  git(main, "worktree", "add", "--detach", paths.detached);
  await writeFile(path.join(paths.dirty, "README.md"), "보존해야 하는 변경\n");
  await writeFile(
    path.join(paths.untracked, "untracked.txt"),
    "보존해야 하는 미추적 파일\n",
  );
  await writeFile(
    path.join(paths.ignored, "local-secret.txt"),
    "보존해야 하는 ignored 파일\n",
  );
  git(main, "worktree", "lock", "--reason", "dev 보호 검증", paths.locked);
  git(paths["index-flags"], "update-index", "--assume-unchanged", "README.md");
  const fixture = { base, main, paths };
  await writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  return fixture;
}
if (process.argv.includes("--fixtures-only")) {
  console.log(JSON.stringify(await createFixtures()));
  process.exit(0);
}
const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
const endpoint = "http://127.0.0.1:19281/api/v1";
async function api(
  route,
  body,
  method = body === undefined ? "GET" : "POST",
  expectedStatus = 200,
) {
  const response = await fetch(endpoint + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    `${route}: ${JSON.stringify(data)}`,
  );
  if (expectedStatus === 200)
    assert.notEqual(data.success, false, JSON.stringify(data));
  return data;
}
const health = await api("/health");
assert.equal(health.instance.buildKind, "dev");
assert.equal(
  path.resolve(health.instance.worktreeRoot).toLowerCase(),
  path.resolve(repo).toLowerCase(),
);
const results = [];
const inspect = async (tree) =>
  (await api("/worktrees/inspect", { workingDir: fixture.main, path: tree }))
    .data;
const remove = (tree, head, status = 200) =>
  api(
    "/worktrees/remove",
    {
      workingDir: fixture.main,
      path: tree,
      expectedHead: head,
    },
    "POST",
    status,
  );
const snapshot = (
  await api(`/worktrees?workingDir=${encodeURIComponent(fixture.main)}`)
).data;
assert.equal(snapshot.worktrees.length, 13);
assert.deepEqual(snapshot.usageWarnings, []);
results.push("실제 Git 워크트리 13개 조회");
for (const [name, blocker] of [
  ["main", "main"],
  ["dirty", "tracked_changes"],
  ["untracked", "untracked_files"],
  ["ignored", "ignored_files"],
  ["locked", "locked"],
  ["detached", "detached"],
  ["index-flags", "index_flags"],
]) {
  const tree = name === "main" ? fixture.main : fixture.paths[name];
  const detail = await inspect(tree);
  assert.equal(detail.canRemove, false, name);
  assert.ok(detail.blockers.includes(blocker), `${name}: ${detail.blockers}`);
  await remove(tree, detail.worktree.head, 409);
  await access(tree);
  results.push(`${name}: ${blocker} 제거 거부·폴더 보존`);
}
const staleHead = await inspect(fixture.paths["stale-head"]);
git(
  fixture.paths["stale-head"],
  "commit",
  "--allow-empty",
  "-m",
  "after inspection",
);
await remove(fixture.paths["stale-head"], staleHead.worktree.head, 409);
results.push("검사 이후 HEAD 변경 제거 거부");
const staleFiles = await inspect(fixture.paths["stale-files"]);
await writeFile(
  path.join(fixture.paths["stale-files"], "after-inspection.txt"),
  "보존\n",
);
await remove(fixture.paths["stale-files"], staleFiles.worktree.head, 409);
results.push("검사 이후 새 파일 생성 제거 거부");
const done = await inspect(fixture.paths["done-api"]);
assert.equal(done.canRemove, true, JSON.stringify(done));
await remove(fixture.paths["done-api"], done.worktree.head);
await assert.rejects(access(fixture.paths["done-api"]));
assert.equal(
  git(fixture.main, "rev-parse", "refs/heads/done-api"),
  done.worktree.head,
);
results.push("API 정상 제거·브랜치 보존");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9342");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) =>
    /^http:\/\/(localhost|127\.0\.0\.1):1420\/$/.test(candidate.url()),
  );
assert.ok(page, "dev WebView 페이지");
const postponeHooks = page.getByRole("button", { name: "나중에", exact: true });
if (await postponeHooks.isVisible()) await postponeHooks.click();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const workspace = (
  await api(
    "/workspaces",
    {
      name: "워크트리 실기 검증",
      layoutId: "default-layout",
    },
    "POST",
    201,
  )
).workspace;
await api("/workspaces/active", { id: workspace.id });
await api(
  "/panes/0/view",
  { type: "WorktreeView", repositoryPath: fixture.main },
  "PUT",
);
const active = (await api("/workspaces/active")).workspace;
const paneId = active.panes[0].id;
const view = page.locator(
  `[data-testid="view-worktree"][data-pane-id="${paneId}"]`,
);
await view.waitFor({ timeout: 30_000 });
await view.locator("[data-worktree-path]").first().waitFor({ timeout: 30_000 });
await page.waitForFunction(
  (id) =>
    !document
      .querySelector(`[data-testid="view-worktree"][data-pane-id="${id}"]`)
      ?.textContent?.includes("내용 검사 중"),
  paneId,
);
await view.getByRole("button", { name: /^정리 후보/ }).waitFor();
await api("/ui/worktrees", {
  paneId,
  action: "select",
  path: snapshot.worktrees.find(
    (row) => path.resolve(row.path) === path.resolve(fixture.paths.dirty),
  ).path,
});
await view.getByTestId("worktree-detail-summary").waitFor();
assert.equal(await view.getByTestId("worktree-remove").isDisabled(), true);
await api("/screenshot", undefined, "POST");
await page.screenshot({ path: path.join(artifacts, "dirty-detail.png") });
results.push("Automation 상세 선택·변경 파일 제거 버튼 비활성");
await view.locator("summary").click();
await view
  .getByRole("button", { name: "변경 · README.md", exact: true })
  .click();
await page.getByTestId("file-viewer-overlay").waitFor();
await page.getByTestId("file-viewer-source-mode").click();
await page
  .getByTestId("file-viewer-text")
  .getByText("보존해야 하는 변경", { exact: false })
  .waitFor();
await page.screenshot({ path: path.join(artifacts, "file-content.png") });
await page.getByTestId("file-viewer-overlay-close").click();
results.push("변경 파일 목록에서 실제 파일 내용 열기");
const uiPath = snapshot.worktrees.find(
  (row) => path.resolve(row.path) === path.resolve(fixture.paths["done-ui"]),
).path;
await api("/ui/worktrees", { paneId, action: "select", path: uiPath });
await view.getByTestId("worktree-remove").waitFor();
await view.getByTestId("worktree-remove").click();
await page.screenshot({
  path: path.join(artifacts, "remove-confirmation.png"),
});
await view.getByTestId("worktree-confirm-remove").click();
await view
  .getByText(`제거 완료: ${uiPath}`, { exact: true })
  .waitFor({ timeout: 30_000 });
await assert.rejects(access(fixture.paths["done-ui"]));
assert.equal(
  git(fixture.main, "rev-parse", "refs/heads/done-ui"),
  done.worktree.head,
);
results.push("실제 UI 확인 후 제거·브랜치 보존");

// 선택한 worktree를 새 실제 터미널에서 열어 CWD와 사용 정보·제거 보호를 확인한다.
const inUse = snapshot.worktrees.find(
  (row) => path.resolve(row.path) === path.resolve(fixture.paths["in-use"]),
).path;
await api("/ui/worktrees", { paneId, action: "select", path: inUse });
await view.getByRole("button", { name: "새 터미널", exact: true }).click();
let usageDetail;
for (let attempt = 0; attempt < 40; attempt++) {
  usageDetail = await inspect(fixture.paths["in-use"]);
  if (usageDetail.usage.some((usage) => usage.kind === "live")) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(
  usageDetail.usage.some((usage) => usage.kind === "live"),
  JSON.stringify(usageDetail),
);
assert.ok(usageDetail.blockers.includes("in_use"));
await remove(fixture.paths["in-use"], usageDetail.worktree.head, 409);
results.push("실제 새 터미널 CWD·live 사용 정보·사용 중 제거 거부");
await api("/panes/layers/activate", { layerId: paneId });
await api("/ui/worktrees", { paneId, action: "refresh" });
await view.waitFor();
await page.waitForFunction((id) => {
  const view = document.querySelector(
    `[data-testid="view-worktree"][data-pane-id="${id}"]`,
  );
  return (
    view?.querySelector("[data-worktree-path]") &&
    !view.textContent?.includes("내용 검사 중")
  );
}, paneId);
if (await postponeHooks.isVisible()) await postponeHooks.click();
await api("/ui/worktrees", { paneId, action: "filter", filter: "candidates" });
await page.screenshot({ path: path.join(artifacts, "candidates.png") });
await api("/ui/worktrees", { paneId, action: "filter", filter: "all" });
await api("/screenshot", undefined, "POST");
await page.screenshot({ path: path.join(artifacts, "overview.png") });
assert.deepEqual(errors, []);
const report = {
  health,
  fixture,
  workspaceId: workspace.id,
  paneId,
  results,
  screenshots: artifacts,
};
await writeFile(
  path.join(artifacts, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
await browser.close();
