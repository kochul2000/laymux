import { test as base, expect, type Page } from "@playwright/test";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

const test = base.extend<{ appPage: Page }>({
  appPage: async ({ page }, use) => {
    await page.addInitScript(TAURI_MOCK_SCRIPT);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Vite's dev telemetry can keep networking active after the app is ready.
    await expect(page.getByTestId("workspace-area")).toBeVisible();
    await use(page);
  },
});

async function observeClose(page: Page, failSave = false) {
  await page.evaluate((failSave) => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      __tauriMockEmit: (event: string, payload: unknown) => void;
      closeTest: { begins: number; saves: unknown[] };
    };
    host.closeTest = { begins: 0, saves: [] };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "get_terminal_session_attributions" || cmd === "get_terminal_cwds") return {};
      if (cmd === "plugin:window|close") {
        host.__tauriMockEmit("tauri://close-requested", null);
        return;
      }
      if (cmd === "begin_app_close") {
        host.closeTest.begins++;
        // Keep the test app alive through the existing updater exclusion path.
        throw new Error("update already in progress");
      }
      if (cmd === "save_settings") {
        if (failSave) throw new Error("disk full");
        host.closeTest.saves.push(args);
      }
      return original(cmd, args);
    };
  }, failSave);
}

const closeState = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          closeTest: {
            begins: number;
            saves: { settings: { exit: { confirmBeforeExit: boolean } } }[];
          };
        }
      ).closeTest,
  );

test("기본 종료 확인은 취소와 Escape로 닫히며 체크 상태를 버린다", async ({ appPage: page }) => {
  await observeClose(page);
  await page.getByTestId("window-close").click();
  const modal = page.getByTestId("close-confirmation-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: /취소|Cancel/ })).toBeFocused();
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: /취소|Cancel/ }).click();
  await expect(modal).not.toBeVisible();
  expect((await closeState(page)).begins).toBe(0);
  expect((await closeState(page)).saves).toEqual([]);
  await page.getByTestId("window-close").click();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("checkbox")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  expect((await closeState(page)).begins).toBe(0);
});

test("다시 보지 않기로 종료하면 설정을 저장하고 다음 종료 요청은 확인을 건너뛴다", async ({
  appPage: page,
}) => {
  await observeClose(page);
  await page.getByTestId("window-close").click();
  const modal = page.getByTestId("close-confirmation-modal");
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: /^(종료|Exit)$/ }).click();
  await expect(modal).not.toBeVisible();
  await expect.poll(async () => (await closeState(page)).begins).toBe(1);
  expect((await closeState(page)).saves.at(-1)?.settings.exit.confirmBeforeExit).toBe(false);
  await page
    .getByTestId("lifecycle-modal")
    .getByRole("button", { name: /나중에|Later/ })
    .click();
  await page.getByTestId("window-close").click();
  await expect.poll(async () => (await closeState(page)).begins).toBe(2);
  await expect(modal).not.toBeVisible();
});

test("설정 저장 실패는 종료를 시작하지 않고 오류와 취소를 표시한다", async ({ appPage: page }) => {
  await observeClose(page, true);
  await page.getByTestId("window-close").click();
  const modal = page.getByTestId("close-confirmation-modal");
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: /^(종료|Exit)$/ }).click();
  await expect(modal.getByRole("alert")).toContainText("disk full");
  await expect(modal).toBeVisible();
  expect((await closeState(page)).begins).toBe(0);
  await modal.getByRole("button", { name: /취소|Cancel/ }).click();
  await expect(modal).not.toBeVisible();
});

test("설정 화면에서 기본 켜짐을 확인하고 종료 확인을 해제하여 저장한다", async ({
  appPage: page,
}) => {
  await observeClose(page);
  await page.keyboard.press("Control+,");
  await page.getByTestId("nav-terminal").click();
  const toggle = page.getByTestId("confirm-before-exit-toggle");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: "../.screenshots/desktop-exit-confirmation-settings.png" });
  await toggle.click();
  await page.getByTestId("save-settings-btn").click();
  await expect
    .poll(async () => (await closeState(page)).saves.at(-1)?.settings.exit.confirmBeforeExit)
    .toBe(false);
  await page.keyboard.press("Control+,");
  await page.getByTestId("window-close").click();
  await expect.poll(async () => (await closeState(page)).begins).toBe(1);
  await expect(page.getByTestId("close-confirmation-modal")).not.toBeVisible();
});
