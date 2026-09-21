/* global fetch */
// Run only against a newly launched, isolated APPDATA dev instance (19281).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

assert.equal(process.env.LAYMUX_REPRO_ISOLATED, "1");
const root = path.resolve("..");
const base = "http://127.0.0.1:19281";
const health = await (await fetch(`${base}/api/v1/health`)).json();
assert.equal(health.port, 19281);
assert.equal(health.instance.buildKind, "dev");
assert.equal(health.instance.pid, Number(process.env.LAYMUX_REPRO_PID));
assert.equal(path.resolve(health.instance.worktreeRoot).toLowerCase(), root.toLowerCase());
assert.equal(
  path.resolve(health.instance.executablePath).toLowerCase(),
  path.join(root, "target/debug/laymux.exe").toLowerCase(),
);
assert.equal(
  health.instance.gitCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);

const desktop = await chromium.connectOverCDP("http://127.0.0.1:9229");
const pc = desktop
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith("http://localhost:1420"));
assert(pc, "Dev WebView not found");
const token = randomUUID();
const mobile = await chromium.launch({ headless: true });
const context = await mobile.newContext({
  viewport: { width: 390, height: 780 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const artifacts = path.join(root, ".tmp/remote-memo-live");
mkdirSync(artifacts, { recursive: true });
try {
  await pc.evaluate(async (token) => {
    const api = await import("/src/lib/tauri-api.ts");
    await api.setRemoteRuntimeAccess(true, token);
  }, token);
  assert.equal((await fetch(`${base}/remote/v1/memos?leaseId=bad`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/remote/v1/memos?leaseId=bad`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    409,
  );
  await page.goto(`${base}/remote/#token=${encodeURIComponent(token)}`);
  assert.equal(
    (
      await fetch(`${base}/remote/v1/memos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          leaseId: "bad",
          key: "memo-test",
          content: "denied",
          expectedContent: "",
        }),
      })
    ).status,
    409,
  );
  await page.locator("#connect").click();
  await expect(page.locator("#memoHeader")).toBeVisible({ timeout: 20000 });
  await page.locator("#memoHeader").click();
  // Includes the live, not-yet-saved empty dock MemoView.
  await expect(page.locator("#memoText")).toBeEnabled();
  await expect(page.locator("#memoText")).toHaveValue("");
  const key = await page.locator("#memoSelect").inputValue();
  const pcMemo = pc.getByTestId("memo-textarea").first();
  await expect(pcMemo).toBeVisible();
  await page.locator("#memoText").fill("모바일 → PC 공유 메모");
  await page.locator("#memoSave").click();
  await expect(page.locator("#memoStatus")).toHaveText("Saved on PC");
  await expect(pcMemo).toHaveValue("모바일 → PC 공유 메모", { timeout: 10000 });
  await pcMemo.fill("PC → 모바일 공유 메모");
  await expect
    .poll(() =>
      pc.evaluate(async (key) => {
        const api = await import("/src/lib/tauri-api.ts");
        return api.loadMemo(key);
      }, key),
    )
    .toBe("PC → 모바일 공유 메모");
  await page.locator("#memoReload").click();
  await expect(page.locator("#memoText")).toHaveValue("PC → 모바일 공유 메모");

  await page.locator("#memoText").fill("충돌해도 보존할 모바일 초안");
  await pcMemo.fill("PC에서 동시에 수정");
  await expect
    .poll(() =>
      pc.evaluate(async (key) => {
        const api = await import("/src/lib/tauri-api.ts");
        return api.loadMemo(key);
      }, key),
    )
    .toBe("PC에서 동시에 수정");
  await page.locator("#memoSave").click();
  await expect(page.locator("#memoStatus")).toContainText("Memo changed");
  await expect(page.locator("#memoText")).toHaveValue("충돌해도 보존할 모바일 초안");
  await expect(pcMemo).toHaveValue("PC에서 동시에 수정");
  await page.screenshot({ path: path.join(artifacts, "shared-memo-conflict.png") });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#memoReload").click();
  await expect(page.locator("#memoText")).toHaveValue("PC에서 동시에 수정");
  await page.locator("#memoClose").click();
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#settingsTabPanels").click();
  await page.locator("#headerMemo").uncheck();
  await page.locator("#rightSwipeView").selectOption("memo");
  await expect(page.locator("#memoHeader")).toBeHidden();
  await page.screenshot({ path: path.join(artifacts, "panel-settings.png") });
  console.log(
    JSON.stringify({
      ok: true,
      pid: health.instance.pid,
      key,
      checked: [
        "empty PC memo discovery",
        "mobile → PC",
        "PC → mobile",
        "409 preserves both drafts",
        "401/409 auth gates",
        "header preferences",
      ],
      artifacts,
    }),
  );
} finally {
  await context.close();
  await mobile.close();
  await pc
    .evaluate(async () => {
      const api = await import("/src/lib/tauri-api.ts");
      await api.setRemoteRuntimeAccess(false);
    })
    .catch(() => {});
  await desktop.close();
}
