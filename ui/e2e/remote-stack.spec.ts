import { expect, test, type Page } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

async function installHost(page: Page, failStack = false) {
  const started = new Set(["terminal-source"]);
  const outputs: string[] = [];
  const focuses: string[] = [];
  let stacked = false;
  await page.addInitScript(() => {
    localStorage.setItem(
      "laymux.remote.keybar",
      JSON.stringify({
        zones: {
          main: { left: ["soft:stackPane"], center: [], right: [] },
          expanded: { left: [], center: [], right: [] },
        },
      }),
    );
  });
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session/claim")) {
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
    } else if (url.pathname.endsWith("/navigation")) {
      const panes = (stacked ? ["source", "new"] : ["source"]).map((id, index) => ({
        id,
        terminalId: `terminal-${id}`,
        viewType: "TerminalView",
        location: "workspace",
        workspaceId: "ws",
        paneIndex: 0,
        paneNumber: index + 1,
        slotId: "source",
        layerIndex: index,
        layerCount: stacked ? 2 : 1,
        activeLayer: stacked ? id === "new" : true,
        terminalLive: started.has(`terminal-${id}`),
        title: id,
        profile: "WSL",
        cwd: "/tmp",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      }));
      await route.fulfill({
        json: {
          activeWorkspaceId: "ws",
          activeWorkspace: { id: "ws", name: "Stack", focusedPaneNumber: stacked ? 2 : 1, panes },
          workspaces: [{ id: "ws", name: "Stack", isActive: true, panes }],
          terminals: panes
            .filter((p) => p.terminalLive)
            .map((p) => ({
              id: p.terminalId,
              title: p.title,
              profile: p.profile,
              workspaceId: "ws",
              appearance: {},
            })),
          docks: [],
          notifications: [],
        },
      });
    } else if (url.pathname.endsWith("/panes/source/stack")) {
      expect(route.request().postDataJSON()).toEqual({ leaseId: "lease-1" });
      if (failStack) await route.fulfill({ status: 400, json: { error: "Stack rejected" } });
      else {
        stacked = true;
        await route.fulfill({
          json: { stacked: "source", layerId: "new", terminalId: "terminal-new" },
        });
      }
    } else if (url.pathname.endsWith("/focus")) {
      const terminalId = url.pathname.split("/").at(-2)!;
      focuses.push(terminalId);
      started.add(terminalId);
      await route.fulfill({ json: { focused: terminalId } });
    } else await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (socket) => {
    outputs.push(socket.url().match(/terminals\/([^/]+)\/output/)![1]);
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect.poll(() => outputs.at(-1)).toBe("terminal-source");
  return { outputs, focuses };
}

test.describe("Remote Stack", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 720, height: 900 } });

  test("새 레이어의 PTY를 열고 연결하며 재진입·스킵을 제공한다", async ({ page }) => {
    const host = await installHost(page);
    await page.locator('[data-key="stackPane"]').tap();
    await expect.poll(() => host.focuses).toContain("terminal-new");
    await expect.poll(() => host.outputs.at(-1)).toBe("terminal-new");
    await page.locator("#navToggle").tap();
    const row = page.locator('[data-pane-row="new"]');
    await expect(row).toHaveJSProperty("tagName", "BUTTON");
    const skip = page.locator('[data-pane-skip="new"]');
    await skip.tap();
    await expect(skip).toHaveAttribute("aria-pressed", "true");
    await skip.tap();
    await expect(skip).toHaveAttribute("aria-pressed", "false");
    await page.locator('[data-pane-row="source"]').tap();
    await expect.poll(() => host.outputs.at(-1)).toBe("terminal-source");
    await page.locator("#navToggle").tap();
    await row.tap();
    await expect.poll(() => host.outputs.at(-1)).toBe("terminal-new");
  });

  test("생성 실패 시 원래 터미널 연결을 유지한다", async ({ page }) => {
    const host = await installHost(page, true);
    await page.locator('[data-key="stackPane"]').tap();
    await expect(page.locator("#status")).toContainText("Stack failed:");
    expect(host.outputs).toEqual(["terminal-source"]);
    expect(host.focuses).not.toContain("terminal-new");
  });

  test("생성 응답 전에 제어권을 반납하면 새 터미널에 연결하지 않는다", async ({ page }) => {
    const host = await installHost(page);
    let respond: (() => Promise<void>) | undefined;
    await page.route("**/remote/v1/panes/source/stack", async (route) => {
      await new Promise<void>((resolve) => {
        respond = async () => {
          await route.fulfill({ json: { layerId: "new", terminalId: "terminal-new" } });
          resolve();
        };
      });
    });
    await page.locator('[data-key="stackPane"]').tap();
    await expect.poll(() => Boolean(respond)).toBe(true);
    await page.locator("#exit").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#connect")).toBeEnabled();
    const response = page.waitForResponse("**/remote/v1/panes/source/stack");
    await respond!();
    await (await response).finished();
    await expect(page.locator("#status")).toContainText("Exited remote control.");
    expect(host.outputs).toEqual(["terminal-source"]);
    expect(host.focuses).not.toContain("terminal-new");
  });
});
