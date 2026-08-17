import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

// Issue #779: a pane the desktop has not opened yet owns no PTY, so the
// navigation payload reports `terminalLive: false` for it. Remote used to treat
// that as "not enterable" — the pane row was inert and, when nothing in the
// workspace was live, the page dead-ended on "No open terminal sessions." with
// no way back. Entering such a pane must ask the host to open it and then
// attach, the same way step navigation lands on a queued pane (ADR-0039).

interface HostTerminal {
  id: string;
  paneId: string;
  paneNumber: number;
  title: string;
}

const HOST_TERMINALS: HostTerminal[] = [
  { id: "term-a1", paneId: "pane-a1", paneNumber: 1, title: "A1" },
  { id: "term-a2", paneId: "pane-a2", paneNumber: 2, title: "A2" },
];

/**
 * Mock desktop where panes start cold. A pane only gets a PTY once the host is
 * asked to focus it — that is what the desktop startup slot does when Remote
 * focuses a queued pane.
 */
async function mockColdHost(
  page: import("@playwright/test").Page,
  started: Set<string>,
  focusCalls: string[],
  openedOutputs: string[],
) {
  await installRemoteClientRoutes(page);

  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      const panes = HOST_TERMINALS.map((terminal) => ({
        id: terminal.paneId,
        location: "workspace",
        workspaceId: "ws-a",
        paneIndex: terminal.paneNumber - 1,
        paneNumber: terminal.paneNumber,
        viewType: "TerminalView",
        terminalId: terminal.id,
        terminalLive: started.has(terminal.id),
        title: terminal.title,
        profile: "pwsh",
      }));
      await route.fulfill({
        json: {
          activeWorkspaceId: "ws-a",
          terminals: HOST_TERMINALS.filter((terminal) => started.has(terminal.id)).map(
            (terminal) => ({
              id: terminal.id,
              title: terminal.title,
              profile: "pwsh",
              workspaceId: "ws-a",
              paneNumber: terminal.paneNumber,
              appearance: {},
            }),
          ),
          activeWorkspace: { id: "ws-a", name: "Alpha", focusedPaneNumber: 1, panes },
          workspaces: [{ id: "ws-a", name: "Alpha", isActive: true, panes }],
          docks: [],
          notifications: [],
        },
      });
      return;
    }
    const focusMatch = url.pathname.match(/^\/remote\/v1\/terminals\/([^/]+)\/focus$/);
    if (focusMatch) {
      const terminalId = decodeURIComponent(focusMatch[1]);
      focusCalls.push(terminalId);
      // The desktop opens the pane as a consequence of focusing it. The session
      // appears after the response, so the client cannot learn from the body
      // that the PTY is there.
      setTimeout(() => started.add(terminalId), 300);
      await route.fulfill({ json: { focused: terminalId } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (ws) => {
    const match = ws.url().match(/terminals\/([^/]+)\/output/);
    if (match) openedOutputs.push(decodeURIComponent(match[1]));
  });
}

test.describe("remote entry into a pane the desktop has not opened", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("connect opens the focused pane instead of dead-ending on no live session", async ({
    page,
  }) => {
    const started = new Set<string>();
    const focusCalls: string[] = [];
    const openedOutputs: string[] = [];
    await mockColdHost(page, started, focusCalls, openedOutputs);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();

    // Nothing is live at connect time, so the client has to ask the host to
    // open the focused pane and attach once its session exists.
    await expect.poll(() => focusCalls).toContain("term-a1");
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a1");
    await expect(page.locator("#terminalMeta")).toContainText("A1");
  });

  test("a not-yet-opened pane row is selectable and starts on tap", async ({ page }) => {
    const started = new Set<string>(["term-a1"]);
    const focusCalls: string[] = [];
    const openedOutputs: string[] = [];
    await mockColdHost(page, started, focusCalls, openedOutputs);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a1");

    // Pane 2 has never been opened on the desktop. Its row must still be an
    // enterable control, and entering it must open the pane on the host.
    await page.locator("#navToggle").click();
    const coldRow = page.locator(".workspace-item.active .workspace-pane-row").nth(1);
    await expect(coldRow).toHaveJSProperty("tagName", "BUTTON");
    await coldRow.click();

    await expect.poll(() => focusCalls).toContain("term-a2");
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a2");
    await expect(page.locator("#terminalMeta")).toContainText("A2");
  });
});
