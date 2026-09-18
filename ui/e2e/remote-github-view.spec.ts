import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

const snapshot = {
  cwd: "/work/repo",
  status: { type: "ready" },
  repo: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  issues: [
    {
      number: 17,
      title: "Mobile GitHub view",
      author: "alice",
      url: "https://github.com/owner/repo/issues/17",
      updatedAt: "2026-09-18T00:00:00Z",
      labels: ["mobile", "enhancement"],
      isDraft: false,
      headRefName: "",
    },
  ],
  pulls: [
    {
      number: 18,
      title: "Ship the remote view",
      author: "bob",
      url: "https://github.com/owner/repo/pull/18",
      updatedAt: "2026-09-18T00:00:00Z",
      labels: ["ready"],
      isDraft: true,
      headRefName: "feat/remote-github",
    },
  ],
  fetchedAtMs: 1,
};

async function installMocks(context: BrowserContext) {
  const snapshotRequests: string[] = [];
  const actionRequests: Array<Record<string, unknown>> = [];
  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-257",
          resumeToken: "resume-257",
          fileViewerToken: "viewer-257",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/session/release") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      const pane = {
        id: "pane-1",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 0,
        paneNumber: 1,
        viewType: "TerminalView",
        terminalId: "terminal-1",
        terminalLive: true,
        title: "Shell",
        profile: "PowerShell",
        cwd: "/work/repo",
        activity: { type: "shell" },
        isFocused: true,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      };
      return route.fulfill({
        json: {
          activeWorkspace: { id: "ws-1", name: "Main", panes: [pane] },
          workspaces: [{ id: "ws-1", name: "Main", isActive: true, hidden: false, panes: [pane] }],
          docks: [],
          terminals: [
            {
              id: "terminal-1",
              title: "Shell",
              profile: "PowerShell",
              cwd: "/work/repo",
              workspaceId: "ws-1",
              paneNumber: 1,
              appearance: {
                fontFamily: "'Cascadia Mono', monospace",
                cursorStyle: "bar",
                cursorWidth: 1,
                theme: {},
              },
            },
          ],
          workspaceSelector: { display: {}, pathEllipsis: "start" },
          notifications: [],
          unreadNotificationCount: 0,
        },
      });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github-repo") {
      return route.fulfill({ json: { cwd: "/work/repo", repoBase: snapshot.repoUrl } });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github") {
      snapshotRequests.push(url.search);
      return route.fulfill({ json: snapshot });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github/actions") {
      actionRequests.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
  await context.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, () => {});
  return { snapshotRequests, actionRequests };
}

async function connect(page: Page) {
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#githubHeader")).toBeVisible();
}

async function flickRightEdge(page: Page) {
  await page.locator("#terminal .xterm").evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.setPointerCapture = () => {};
    target.releasePointerCapture = () => {};
    target.hasPointerCapture = () => false;
    const startX = rect.right - 1;
    const endX = startX - 80;
    const event = (type: string, clientX: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 57,
          pointerType: "touch",
          isPrimary: true,
          clientX,
          clientY: rect.top + rect.height / 2,
        }),
      );
    event("pointerdown", startX);
    event("pointermove", endX);
    event("pointerup", endX);
  });
}

test.describe("Remote GitHub view", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 720 } });

  test("opens beside Explorer and provides the desktop list actions", async ({ context, page }) => {
    const requests = await installMocks(context);
    await connect(page);

    await expect(page.locator("#fileExplorerHeader + #githubHeader")).toBeVisible();
    await page.locator("#githubHeader").click();
    await expect(page.locator("#githubOverlay")).toBeVisible();
    await expect(page.locator("#githubRepo")).toHaveText("owner/repo");
    await expect(page.locator('.github-row[data-github-number="17"]')).toContainText(
      "Mobile GitHub view",
    );
    expect(requests.snapshotRequests).toEqual(["?force=false"]);

    await page.locator("#githubPullsTab").click();
    const pull = page.locator('.github-row[data-github-number="18"]');
    await expect(pull).toContainText("DRAFT");
    await expect(pull.getByRole("button", { name: "Copy branch" })).toBeVisible();
    await pull.getByRole("button", { name: "GitHub actions" }).click();
    await pull.getByRole("button", { name: "Squash and merge" }).click();
    await expect(pull.getByRole("button", { name: "Confirm" })).toBeVisible();
    expect(requests.actionRequests).toEqual([]);
    await pull.getByRole("button", { name: "Confirm" }).click();
    await expect
      .poll(() => requests.actionRequests)
      .toEqual([{ leaseId: "lease-257", action: "pr.squash", number: 18 }]);
    await expect.poll(() => requests.snapshotRequests.at(-1)).toBe("?force=true");
  });

  test("persists GitHub as the device-local right swipe target", async ({ context, page }) => {
    await installMocks(context);
    await connect(page);

    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabDisplay").click();
    await page.locator("#rightSwipeView").selectOption("github");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.rightSwipeView")))
      .toBe("github");
    await page.locator("#navToggle").click();

    await flickRightEdge(page);
    await expect(page.locator("#githubOverlay")).toBeVisible();
    await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  });
});
