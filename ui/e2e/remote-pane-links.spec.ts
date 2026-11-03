import { expect, test, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

const sourceId = "terminal-pane-aaaaaaaa";
const targetId = "terminal-pane-1b7d7a95";
const references = [targetId, "pane-1b7d7a95", "lx:pane:laymux-0:1"];

type RemoteWindow = Window & {
  Terminal: { prototype: { reset: (...args: unknown[]) => unknown } };
  __paneLinkTerm?: {
    cols: number;
    rows: number;
    buffer: {
      active: { getLine: (row: number) => { translateToString: () => string } | undefined };
    };
  };
};

function pane(terminalId: string, workspaceId: string) {
  return {
    id: terminalId.slice("terminal-".length),
    terminalId,
    workspaceId,
    paneIndex: 0,
    paneNumber: 1,
    viewType: "terminal",
    location: "workspace",
    terminalLive: true,
    title: "Shell",
    profile: "PowerShell",
    cwd: "C:\\work",
    activity: { type: "shell" },
    isFocused: false,
    hidden: false,
    collapsed: false,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    unreadCount: 0,
  };
}

async function setup(page: Page, initiallyEnabled = true, initiallyHasTarget = true) {
  let enabled = initiallyEnabled;
  let hasTarget = initiallyHasTarget;
  let active = sourceId;
  const focused: string[] = [];
  const attached: string[] = [];
  const sourcePane = pane(sourceId, "ws-source");
  const targetPane = pane(targetId, "ws-target");
  const workspaces = [
    { id: "ws-source", name: "Source", panes: [sourcePane] },
    { id: "ws-target", name: "laymux-0", panes: [targetPane] },
  ];
  await page.route("http://remote.test/remote/**", async (route) => {
    const url = new URL(route.request().url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname.endsWith("/session/claim"))
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-pane-links",
          resumeToken: "resume",
          heartbeatTimeoutSeconds: 9,
        },
      });
    if (url.pathname.endsWith("/session/heartbeat"))
      return route.fulfill({
        json: { active: true, leaseId: "lease-pane-links", paneLinkEnabled: enabled },
      });
    if (url.pathname.endsWith("/navigation")) {
      const current = workspaces[active === sourceId ? 0 : 1];
      return route.fulfill({
        json: {
          activeWorkspaceId: current.id,
          activeWorkspace: { ...current, focusedPaneNumber: 1 },
          workspaces: workspaces
            .filter((workspace) => hasTarget || workspace.id === "ws-source")
            .map((workspace) => ({
              ...workspace,
              isActive: workspace.id === current.id,
              hidden: false,
              collapsed: false,
              paneCount: 1,
              terminalPaneCount: 1,
              liveTerminalCount: 1,
              unreadCount: 0,
            })),
          docks: [],
          terminals: (hasTarget ? [sourcePane, targetPane] : [sourcePane]).map((item) => ({
            ...item,
            id: item.terminalId,
            appearance: {},
          })),
          notifications: [],
          unreadNotificationCount: 0,
          paneLinkEnabled: enabled,
          workspaceSelector: { display: {}, pathEllipsis: "start" },
        },
      });
    }
    if (url.pathname.endsWith("/focus")) {
      active = decodeURIComponent(url.pathname.split("/").at(-2)!);
      focused.push(active);
      return route.fulfill({ json: { focused: active } });
    }
    if (url.pathname.endsWith("/github-repo")) return route.fulfill({ json: { repoBase: null } });
    if (url.pathname.endsWith("/resize")) return route.fulfill({ json: { resized: true } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/.*\/output/, (socket) => {
    const id = decodeURIComponent(new URL(socket.url()).pathname.split("/").at(-2)!);
    attached.push(id);
    const text =
      id === sourceId ? `    리뷰어\r\n    ${references.join("\r\n    ")}\r\n` : "TARGET PANE\r\n";
    const payload = Buffer.from(text, "utf8");
    socket.send(
      JSON.stringify({
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
      }),
    );
    socket.send(payload);
  });
  await page.goto("http://remote.test/remote/#token=pane-links");
  await page.evaluate(() => {
    const target = window as RemoteWindow;
    const reset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function (...args) {
      target.__paneLinkTerm = this as unknown as RemoteWindow["__paneLinkTerm"];
      return reset.apply(this, args);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Source · Pane 1");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as RemoteWindow).__paneLinkTerm?.buffer.active.getLine(3)?.translateToString(),
      ),
    )
    .toContain(references[2]);
  return {
    focused,
    attached,
    addTarget: () => {
      hasTarget = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}

async function clickReference(page: Page, row: number, touch: boolean) {
  const box = await page.locator(".xterm-screen").boundingBox();
  const geometry = await page.evaluate(() => {
    const term = (window as RemoteWindow).__paneLinkTerm!;
    return { cols: term.cols, rows: term.rows };
  });
  const x = box!.x + (7.5 * box!.width) / geometry.cols;
  const y = box!.y + ((row + 0.5) * box!.height) / geometry.rows;
  if (touch) await page.touchscreen.tap(x, y);
  else {
    await page.mouse.move(x, y);
    await page.waitForTimeout(100);
    await page.mouse.click(x, y);
  }
}

for (const touch of [false, true]) {
  test.describe(touch ? "모바일 pane 링크" : "PC 브라우저 pane 링크", () => {
    test.use(
      touch
        ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }
        : { viewport: { width: 1000, height: 760 } },
    );
    for (const [index, reference] of references.entries()) {
      test(`${reference} 밑줄을 선택하면 host focus와 출력 attach가 이동한다`, async ({
        page,
      }, testInfo) => {
        const state = await setup(page);
        await expect(page.locator(".pane-link-decoration")).toHaveCount(3);
        if (index === 2) await page.screenshot({ path: testInfo.outputPath("pane-links.png") });
        await clickReference(page, index + 1, touch);
        await expect.poll(() => state.focused).toContain(targetId);
        await expect.poll(() => state.attached).toContain(targetId);
        await expect(page.locator("#status")).toHaveText("laymux-0 · Pane 1");
      });
    }
    test("기본 끔이면 밑줄과 탐색이 없다", async ({ page }) => {
      const state = await setup(page, false);
      await expect(page.locator(".pane-link-decoration")).toHaveCount(0);
      await clickReference(page, 1, touch);
      expect(state.focused).not.toContain(targetId);
      expect(state.attached).not.toContain(targetId);
    });
    test("연결 뒤 생성한 pane도 drawer를 열지 않고 발견한다", async ({ page }) => {
      const state = await setup(page, true, false);
      await expect(page.locator(".app")).not.toHaveClass(/nav-open/);
      await expect(page.locator(".pane-link-decoration")).toHaveCount(0);
      state.addTarget();
      await expect(page.locator(".pane-link-decoration")).toHaveCount(3, { timeout: 6000 });
      await clickReference(page, 1, touch);
      await expect.poll(() => state.focused).toContain(targetId);
    });
    test("최신 host 설정이 끔이면 기존 링크의 클릭도 무시한다", async ({ page }) => {
      const state = await setup(page);
      await expect(page.locator(".pane-link-decoration")).toHaveCount(3);
      state.disable();
      await clickReference(page, 1, touch);
      await expect(page.locator(".pane-link-decoration")).toHaveCount(0);
      expect(state.focused).not.toContain(targetId);
    });
    test("drawer가 닫혀 있어도 heartbeat로 밑줄을 해제한다", async ({ page }) => {
      const state = await setup(page);
      await expect(page.locator(".pane-link-decoration")).toHaveCount(3);
      state.disable();
      await expect(page.locator(".pane-link-decoration")).toHaveCount(0, { timeout: 12000 });
    });
  });
}
