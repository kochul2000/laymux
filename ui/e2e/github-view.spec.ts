import { test, expect, type Page } from "./fixtures";

/**
 * The row menu's placement is a layout question — which is exactly what jsdom
 * cannot answer. These run in a real browser so the menu's box can be compared
 * against the scrolling list that would clip it.
 */

const PANE = "[data-testid='workspace-pane-1']";

async function openGitHubViewInSecondPane(page: Page) {
  const firstPane = page.locator("[data-testid='workspace-pane-0']");
  await firstPane.hover();
  await expect(firstPane.locator("[data-testid='pane-control-bar']")).toBeVisible({
    timeout: 3000,
  });
  await page.getByTestId("pane-control-split-v").click();

  await page.locator(`${PANE} [data-testid='empty-view-github']`).click();
  await expect(page.locator(`${PANE} [data-testid='view-github']`)).toBeVisible();

  // The view follows the sync group's CWD; without one it never asks the
  // backend for a repository at all.
  await page.evaluate(() => {
    (
      window as unknown as {
        __tauriMockEmit: (name: string, payload: unknown) => void;
      }
    ).__tauriMockEmit("sync-cwd", {
      path: "D:/repo",
      terminalId: "terminal-elsewhere",
      groupId: "ws-default",
      targets: [],
      force: true,
    });
  });
}

test.describe("GitHubView", () => {
  test("lists the repository of the CWD it receives", async ({ appPage: page }) => {
    await openGitHubViewInSecondPane(page);

    await expect(page.locator(`${PANE} [data-testid='github-repo']`)).toHaveText("owner/repo");
    await expect(page.locator(`${PANE} [data-testid='github-tab-issues']`)).toHaveText("Issues 30");
    await expect(page.locator(`${PANE} [data-testid='github-item-1']`)).toBeVisible();
  });

  test("a row menu opens inside the list instead of being clipped by it", async ({
    appPage: page,
  }) => {
    await openGitHubViewInSecondPane(page);
    await expect(page.locator(`${PANE} [data-testid='github-item-30']`)).toBeAttached();

    // The last row sits at the bottom edge once scrolled to: the case where a
    // menu anchored below it lands outside the visible list.
    await page.locator(`${PANE} [data-testid='github-menu-30']`).click();

    const panel = page.locator(`${PANE} [data-testid='github-menu-panel-30']`);
    await expect(panel).toBeVisible();

    const listBox = await page.locator(`${PANE} [data-testid='github-list']`).boundingBox();
    const panelBox = await panel.boundingBox();
    expect(listBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    if (!listBox || !panelBox) return;

    // The actual defect, asserted before the placement attribute: both edges
    // inside the scroll container, so nothing is cut off and nothing has to be
    // scrolled to. One pixel of slack for sub-pixel layout.
    expect(panelBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
    await expect(panel).toHaveAttribute("data-placement", "up");
  });
});
