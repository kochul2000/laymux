import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

// A pane switch keeps the previous pane's screen until the new pane's snapshot
// lands (api-contracts.md §terminal output attach). On a slow link that left
// the header naming the new pane over the old pane's frozen output with nothing
// saying a switch was in flight. The surface now dims from the moment a move
// starts until the new screen is on it.

interface HostTerminal {
  id: string;
  paneId: string;
  paneNumber: number;
  title: string;
}

const HOST_TERMINALS: HostTerminal[] = [
  { id: "term-a1", paneId: "pane-a1", paneNumber: 1, title: "A1" },
  { id: "term-a2", paneId: "pane-a2", paneNumber: 2, title: "A2" },
  { id: "term-a3", paneId: "pane-a3", paneNumber: 3, title: "A3" },
];

function snapshotFrames(text: string): { header: string; payload: Buffer } {
  const payload = Buffer.from(text, "utf8");
  const header = JSON.stringify({
    type: "terminal.output",
    version: 1,
    phase: "snapshot",
    seqStart: 0,
    seqEnd: payload.byteLength,
    byteLength: payload.byteLength,
    state: {
      version: 1,
      generation: 1,
      snapshotStartSeq: 0,
      snapshotSeq: payload.byteLength,
      sourceStartSeq: 0,
      sourceSeq: payload.byteLength,
      snapshotKind: "raw",
      protocolRevision: 0,
      modes: { bracketedPaste: false },
      geometry: { revision: 0, cols: 80, rows: 24 },
    },
  });
  return { header, payload };
}

interface MockHost {
  /** Output sockets the page opened, by terminal id; snapshots are sent by the test. */
  sockets: Map<string, WebSocketRoute>;
  /** Resolves the pending spatial step, if one is held. */
  releaseStep: (() => void) | null;
  stepRequests: number;
}

/**
 * Two live panes and one the desktop never opens. Only term-a1 gets its
 * snapshot automatically; every other attach waits for the test, which is how
 * a slow network looks from the page.
 */
async function mockHost(page: Page): Promise<MockHost> {
  const host: MockHost = { sockets: new Map(), releaseStep: null, stepRequests: 0 };
  const live = new Set(["term-a1", "term-a2"]);
  await installRemoteClientRoutes(page);

  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
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
        terminalLive: live.has(terminal.id),
        title: terminal.title,
        profile: "pwsh",
      }));
      await route.fulfill({
        json: {
          activeWorkspaceId: "ws-a",
          terminals: HOST_TERMINALS.filter((terminal) => live.has(terminal.id)).map((terminal) => ({
            id: terminal.id,
            title: terminal.title,
            profile: "pwsh",
            workspaceId: "ws-a",
            paneNumber: terminal.paneNumber,
            appearance: {},
          })),
          activeWorkspace: { id: "ws-a", name: "Alpha", focusedPaneNumber: 1, panes },
          workspaces: [{ id: "ws-a", name: "Alpha", isActive: true, panes }],
          docks: [],
          notifications: [],
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/navigation/spatial") {
      host.stepRequests += 1;
      await new Promise<void>((resolve) => {
        host.releaseStep = resolve;
      });
      host.releaseStep = null;
      await route.fulfill({
        json: {
          moved: true,
          target: { terminalId: "term-a2", paneId: "pane-a2", workspaceId: "ws-a" },
        },
      });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (ws) => {
    const match = ws.url().match(/terminals\/([^/]+)\/output/);
    if (!match) return;
    const terminalId = decodeURIComponent(match[1]);
    host.sockets.set(terminalId, ws);
    if (terminalId === "term-a1") sendSnapshot(ws, "pane one\r\n");
  });
  return host;
}

function sendSnapshot(ws: WebSocketRoute, text: string) {
  const { header, payload } = snapshotFrames(text);
  ws.send(header);
  ws.send(payload);
}

async function connectOnPaneOne(page: Page) {
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#terminalMeta")).toContainText("A1");
  await expect(page.locator(".xterm-rows")).toContainText("pane one");
}

const surface = (page: Page) => page.locator("#terminal");

test.describe("remote pane switch indicator", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("covers the previous pane's screen until the new pane's snapshot lands", async ({
    page,
  }) => {
    const host = await mockHost(page);
    await connectOnPaneOne(page);
    // A settled attach shows no transition.
    await expect(surface(page)).not.toHaveAttribute("data-transition");

    await page.locator("#navToggle").click();
    await page.locator(".workspace-item.active .workspace-pane-row").nth(1).click();

    // The old screen is still there (the contract keeps it until the new
    // snapshot arrives), but dimmed so it no longer reads as the live pane.
    await expect(surface(page)).toHaveAttribute("data-transition", "pending");
    await expect(page.locator("#terminalMeta")).toContainText("A2");
    await expect(page.locator("#terminal")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".xterm-rows")).toContainText("pane one");

    await expect.poll(() => host.sockets.has("term-a2")).toBe(true);
    sendSnapshot(host.sockets.get("term-a2")!, "pane two\r\n");

    await expect(page.locator(".xterm-rows")).toContainText("pane two");
    await expect(surface(page)).not.toHaveAttribute("data-transition");
    await expect(page.locator("#terminal")).toHaveAttribute("aria-busy", "false");
  });

  test("shows while a step move is still being resolved by the desktop", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "laymux.remote.keybar",
        JSON.stringify({ floating: { pads: { navPad: { enabled: true, x: 0.5, y: 0.5 } } } }),
      ),
    );
    const host = await mockHost(page);
    await connectOnPaneOne(page);
    await expect(surface(page)).not.toHaveAttribute("data-transition");

    const pad = page.locator('#floatingControls [data-key="navPad"]');
    await expect(pad).toBeEnabled();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 32, box.y + 32);
    await page.mouse.down();
    await page.mouse.move(box.x + 32, box.y + 60, { steps: 3 });
    await page.mouse.up();

    // The desktop has not answered yet: the target is unknown, but the move is
    // already under way.
    await expect.poll(() => host.stepRequests).toBe(1);
    await expect(surface(page)).toHaveAttribute("data-transition", "pending");

    host.releaseStep!();
    await expect(page.locator("#terminalMeta")).toContainText("A2");
    await expect.poll(() => host.sockets.has("term-a2")).toBe(true);
    sendSnapshot(host.sockets.get("term-a2")!, "pane two\r\n");
    await expect(surface(page)).not.toHaveAttribute("data-transition");
  });

  test("keeps a pane the desktop never opens dimmed but no longer busy", async ({ page }) => {
    await page.clock.install();
    await mockHost(page);
    await connectOnPaneOne(page);

    await page.locator("#navToggle").click();
    await page.locator(".workspace-item.active .workspace-pane-row").nth(2).click();
    await expect(surface(page)).toHaveAttribute("data-transition", "pending");

    // The open wait polls navigation every 400 ms for up to 20 s; walk the fake
    // clock through it, letting each poll's fetch settle in real time.
    for (let elapsed = 0; elapsed <= 21000; elapsed += 400) {
      await page.clock.fastForward(400);
      await page.waitForTimeout(10);
    }

    await expect(surface(page)).toHaveAttribute("data-transition", "failed");
    await expect(page.locator("#statusText")).toContainText("has not opened");
    await expect(page.locator("#terminal")).toHaveAttribute("aria-busy", "false");
  });
});
