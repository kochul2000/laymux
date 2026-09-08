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

  test("overflowing pane controls open only on click without shrinking the GitHub work area", async ({
    appPage: page,
  }, testInfo) => {
    await openGitHubViewInSecondPane(page);
    // Split while the fixture is at its normal desktop size, then reproduce
    // the responsive collision. This leaves enough width for the GitHub tabs
    // themselves while forcing the larger control cluster onto two rows.
    await page.setViewportSize({ width: 1000, height: 500 });

    const pane = page.locator(PANE);
    const header = pane.getByTestId("view-header-content");
    const list = pane.getByTestId("github-list");
    const issues = pane.getByTestId("github-tab-issues");
    const pulls = pane.getByTestId("github-tab-pulls");

    // Leave both panes so the hover toolbar is absent for the baseline rect.
    await page.mouse.move(2, 2);
    await expect(page.getByTestId("pane-control-floating-menu")).toHaveCount(0);
    const listBefore = await list.boundingBox();
    const issuesBefore = await issues.boundingBox();
    const pullsBefore = await pulls.boundingBox();

    await pane.hover({ position: { x: 12, y: 12 } });
    const toolbar = page.getByTestId("pane-control-floating-menu");
    await expect(toolbar).toHaveCount(0);
    expect(await list.boundingBox()).toEqual(listBefore);
    await page.screenshot({ path: testInfo.outputPath("pane-menu-hover.png") });
    await pane.getByTestId("pane-control-menu-btn").click();
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveAttribute("role", "toolbar");
    const trigger = pane.getByTestId("pane-control-menu-btn");
    await expect(toolbar).toHaveAttribute("data-placement", "up");
    await expect
      .poll(async () => {
        const triggerBox = await trigger.boundingBox();
        const currentToolbarBox = await toolbar.boundingBox();
        if (!triggerBox || !currentToolbarBox) return Number.POSITIVE_INFINITY;
        return Math.abs(currentToolbarBox.y + currentToolbarBox.height - (triggerBox.y - 2));
      })
      .toBeLessThanOrEqual(1);

    const listAfter = await list.boundingBox();
    const headerBox = await header.boundingBox();
    const issuesBox = await issues.boundingBox();
    const pullsBox = await pulls.boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    const paneBox = await pane.boundingBox();
    expect(listBefore).not.toBeNull();
    expect(listAfter).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(issuesBox).not.toBeNull();
    expect(pullsBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    if (
      !listBefore ||
      !listAfter ||
      !headerBox ||
      !issuesBox ||
      !pullsBox ||
      !toolbarBox ||
      !paneBox
    )
      return;

    // A portal overlay must not add a second layout row or change scrolling
    // geometry, while the essential GitHub tabs stay inside the header.
    expect(listAfter.x).toBeCloseTo(listBefore.x, 0);
    expect(listAfter.y).toBeCloseTo(listBefore.y, 0);
    expect(listAfter.width).toBeCloseTo(listBefore.width, 0);
    expect(listAfter.height).toBeCloseTo(listBefore.height, 0);
    expect(issuesBefore).not.toBeNull();
    expect(pullsBefore).not.toBeNull();
    if (!issuesBefore || !pullsBefore) return;
    expect(issuesBox.x).toBeCloseTo(issuesBefore.x, 0);
    expect(issuesBox.y).toBeCloseTo(issuesBefore.y, 0);
    expect(pullsBox.x).toBeCloseTo(pullsBefore.x, 0);
    expect(pullsBox.y).toBeCloseTo(pullsBefore.y, 0);
    expect(issuesBox.x).toBeGreaterThanOrEqual(headerBox.x - 1);
    expect(pullsBox.x + pullsBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
    // This fixture's pane is only 72px tall. The wrapped menu cannot fit under
    // the header, so the context-menu fallback flips it above without overlap.
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(headerBox.y + 1);
    expect(await toolbar.evaluate((node, selector) => node.closest(selector) === null, PANE)).toBe(
      true,
    );

    // The pane width is the first wrapping boundary: the toolbar stays beside
    // its owner instead of stretching across neighbouring panes.
    expect(toolbarBox.width).toBeLessThanOrEqual(paneBox.width + 1);
    const wrappedContent = toolbar.getByTestId("pane-control-floating-content");
    const wrappedBox = await wrappedContent.boundingBox();
    expect(wrappedBox).not.toBeNull();
    if (wrappedBox) expect(wrappedBox.height).toBeGreaterThan(24);

    await page.screenshot({ path: testInfo.outputPath("pane-menu-open.png") });

    // Every action remains rendered and geometrically contained by the
    // wrapped surface, rather than being clipped or dropped at the pane edge.
    for (const testId of [
      "pane-control-view-select",
      "pane-control-cwd-receive",
      "pane-control-split-h",
      "pane-control-split-v",
      "pane-control-hide",
      "pane-control-clear",
      "pane-control-delete",
      "pane-control-pin",
      "pane-control-minimize",
    ]) {
      const action = toolbar.getByTestId(testId);
      await expect(action).toBeVisible();
      const actionBox = await action.boundingBox();
      expect(actionBox).not.toBeNull();
      if (!actionBox) continue;
      expect(actionBox.x).toBeGreaterThanOrEqual(toolbarBox.x - 1);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
        toolbarBox.x + toolbarBox.width + 1,
      );
      expect(actionBox.y).toBeGreaterThanOrEqual(toolbarBox.y - 1);
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
        toolbarBox.y + toolbarBox.height + 1,
      );
    }

    // Crossing the portal gap clears pane hover and unmounts the compact
    // trigger. The menu must retain its measured anchor instead of jumping
    // back into the pane or disappearing under the pointer.
    await toolbar.hover();
    await expect(toolbar).toBeVisible();
    await expect(trigger).toHaveCount(0);
    const toolbarAfterCrossing = await toolbar.boundingBox();
    expect(toolbarAfterCrossing).not.toBeNull();
    if (toolbarAfterCrossing) {
      expect(toolbarAfterCrossing.x).toBeCloseTo(toolbarBox.x, 0);
      expect(toolbarAfterCrossing.y).toBeCloseTo(toolbarBox.y, 0);
    }

    // A roomier header still overflows, but the menu needs only its content width.
    await pane.evaluate((element) => {
      element.style.width = "380px";
    });
    await pane.hover({ position: { x: 12, y: 12 } });
    await expect(toolbar).toBeVisible();
    await expect.poll(async () => (await toolbar.boundingBox())?.width ?? 380).toBeLessThan(380);
    await page.screenshot({ path: testInfo.outputPath("pane-menu-compact.png") });
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
    await page.mouse.move(2, 2);
    await pane.hover({ position: { x: 12, y: 12 } });
    await expect(toolbar).toHaveCount(0);
  });

  test("keeps an intrinsically wide control reachable from a 100px pane and narrower viewport", async ({
    appPage: page,
  }) => {
    await openGitHubViewInSecondPane(page);
    const pane = page.locator(PANE);
    // The grid's supported minimum pane width is 100px. Force that exact
    // geometry without changing component internals so ResizeObserver and the
    // real browser flex/scroll overflow algorithms still own the result.
    await pane.evaluate((element) => {
      element.style.width = "100px";
    });
    await pane.hover({ position: { x: 50, y: 12 } });

    const toolbar = page.getByTestId("pane-control-floating-menu");
    const trigger = pane.getByTestId("pane-control-menu-btn");
    await expect(toolbar).toHaveCount(0);
    await trigger.click();
    await expect(toolbar).toBeVisible();
    const select = toolbar.getByTestId("pane-control-view-select");
    await expect(select).toBeVisible();

    const paneBox = await pane.boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    const selectBox = await select.boundingBox();
    expect(paneBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(selectBox).not.toBeNull();
    if (!paneBox || !toolbarBox || !selectBox) return;
    expect(toolbarBox.width).toBeGreaterThan(paneBox.width);
    expect(selectBox.x).toBeGreaterThanOrEqual(toolbarBox.x - 1);
    expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1);

    // Once even the viewport is narrower than the control, the surface must
    // stay non-zero and expose positive inline-end overflow that can actually
    // be scrolled to. Negative inline-start overflow is not scroll-reachable.
    await page.setViewportSize({ width: 96, height: 500 });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveAttribute("data-constrained-x", "true");
    const metrics = await toolbar.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      maxScrollLeft: element.scrollWidth - element.clientWidth,
    }));
    expect(metrics.clientWidth).toBeGreaterThan(0);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.maxScrollLeft).toBeGreaterThan(0);

    await toolbar.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const scrolledToolbarBox = await toolbar.boundingBox();
    const scrolledSelectBox = await select.boundingBox();
    expect(scrolledToolbarBox).not.toBeNull();
    expect(scrolledSelectBox).not.toBeNull();
    if (!scrolledToolbarBox || !scrolledSelectBox) return;
    expect(scrolledToolbarBox.width).toBeGreaterThan(0);
    expect(scrolledToolbarBox.x).toBeGreaterThanOrEqual(-1);
    expect(scrolledToolbarBox.x + scrolledToolbarBox.width).toBeLessThanOrEqual(97);
    expect(scrolledSelectBox.x + scrolledSelectBox.width).toBeLessThanOrEqual(
      scrolledToolbarBox.x + scrolledToolbarBox.width + 1,
    );
  });
});
