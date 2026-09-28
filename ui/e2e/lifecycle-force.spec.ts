import { test, expect } from "./fixtures";

test("pane 확인 실패 뒤 손실 강행은 명시적 force 설치 요청을 보낸다", async ({ appPage: page }) => {
  const installs: unknown[] = [];
  await page.exposeFunction("recordForceInstall", (args: unknown) => installs.push(args));
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      __tauriMockEmit: (event: string, payload: unknown) => void;
      recordForceInstall: (args: unknown) => Promise<void>;
    };
    const status = {
      enabled: true,
      channel: "stable",
      currentVersion: "1.0.22",
      availableVersion: "1.0.23",
      operation: "preparing",
      downloadedBytes: 100,
      totalBytes: 100,
      preparation: { stage: "checkpoint", completed: 0, total: null },
      exitSettings: { interruptTerminals: true, interruptRounds: 3, settleMs: 700 },
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd !== "install_app_update") return original(cmd, args);
      await host.recordForceInstall(args);
      return {
        ...status,
        operation: "installing",
        forceInstall: true,
        canForceInstall: false,
        lastError: null,
      };
    };
    host.__tauriMockEmit("app-update-status-changed", status);
    host.__tauriMockEmit("app-update-status-changed", {
      ...status,
      operation: "idle",
      canForceInstall: true,
      lastError: "Codex 확인 실패 [개발 · pane 2 · API 작업]",
    });
  });
  const modal = page.getByTestId("lifecycle-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("alert")).toContainText("pane 2");
  await expect(modal.getByRole("alert")).toContainText(/사라질 수|may be lost/);
  expect(installs).toEqual([]);
  await page.screenshot({ path: "../.screenshots/lifecycle-force-desktop.png" });
  await modal
    .getByRole("button", { name: /손실 감수하고 업데이트|Accept loss and update/ })
    .click();
  await expect.poll(() => installs).toEqual([{ force: true }]);
  await expect(
    modal.getByRole("button", { name: /손실 감수하고 업데이트|Accept loss and update/ }),
  ).toHaveCount(0);
  await expect(modal.locator(".lifecycle-step")).toHaveCount(2);
  await expect(modal.locator(".lifecycle-step.is-done")).toHaveCount(1);
  await expect(modal).toContainText(/건너뛰고|Skipped saving restore information/);
  await page.screenshot({ path: "../.screenshots/lifecycle-force-installing.png" });
});
