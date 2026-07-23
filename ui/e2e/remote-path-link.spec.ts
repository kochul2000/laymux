import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    focusedPaneNumber: 1,
    panes: [
      {
        id: "pane-1",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 0,
        paneNumber: 1,
        viewType: "terminal",
        terminalId: "terminal-1",
        terminalLive: true,
        title: "Shell",
        profile: "PowerShell",
        cwd: "C:\\work",
        branch: "main",
        activity: { type: "shell" },
        outputActive: false,
        commandRunning: false,
        isFocused: true,
        unreadCount: 0,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 0.5,
        h: 1,
      },
      {
        id: "pane-2",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 1,
        paneNumber: 2,
        viewType: "terminal",
        terminalId: "terminal-2",
        terminalLive: true,
        title: "Second Shell",
        profile: "PowerShell",
        cwd: "C:\\work",
        branch: "main",
        activity: { type: "shell" },
        outputActive: false,
        commandRunning: false,
        isFocused: false,
        unreadCount: 0,
        hidden: false,
        collapsed: false,
        x: 0.5,
        y: 0,
        w: 0.5,
        h: 1,
      },
    ],
  },
  workspaces: [
    {
      id: "ws-1",
      name: "Main",
      isActive: true,
      hidden: false,
      collapsed: false,
      paneCount: 2,
      terminalPaneCount: 2,
      liveTerminalCount: 2,
      unreadCount: 0,
      panes: undefined,
    },
  ],
  docks: [],
  terminals: [
    {
      id: "terminal-1",
      title: "Shell",
      profile: "PowerShell",
      cwd: "C:\\work",
      workspaceId: "ws-1",
      paneNumber: 1,
      appearance: {},
    },
    {
      id: "terminal-2",
      title: "Second Shell",
      profile: "PowerShell",
      cwd: "C:\\work",
      workspaceId: "ws-1",
      paneNumber: 2,
      appearance: {},
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

function snapshotFrames(text: string): { header: string; payload: Buffer } {
  const payload = Buffer.from(text, "utf8");
  return {
    header: JSON.stringify({
      type: "terminal.output",
      version: 1,
      phase: "snapshot",
      seqStart: 0,
      seqEnd: payload.byteLength,
      byteLength: payload.byteLength,
      state: {
        version: 1,
        snapshotStartSeq: 0,
        snapshotSeq: payload.byteLength,
        protocolRevision: 0,
        modes: { bracketedPaste: false },
      },
    }),
    payload,
  };
}

type CapturedTerminalWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    buffer: {
      active: { getLine: (line: number) => { translateToString: () => string } | undefined };
    };
    select: (column: number, row: number, length: number) => void;
    resize: (cols: number, rows: number) => void;
    cols: number;
    rows: number;
    clearSelection: () => void;
    getSelection: () => string;
  };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("selected desktop-valid relative file is underlined and opens Remote FileViewer", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const pathLinkRequests: Array<{
    authorization: string | null;
    lease: string | null;
    capability: string | null;
    body: Record<string, unknown>;
  }> = [];
  const renderRequests: Array<Record<string, unknown>> = [];
  type PathLinkHold = {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
    resumed: ReturnType<typeof deferred>;
  };
  let nextPathLinkHold: PathLinkHold | null = null;
  const holdNextPathLink = (): PathLinkHold => {
    const hold = { started: deferred(), release: deferred(), resumed: deferred() };
    nextPathLinkHold = hold;
    return hold;
  };

  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/remote/") {
      return route.fulfill({
        path: `${remoteRoot}page.html`,
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/viewer/") {
      return route.fulfill({
        path: `${remoteRoot}viewer_page.html`,
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/viewer/viewer.js") {
      return route.fulfill({
        path: `${remoteRoot}viewer_page.js`,
        contentType: "text/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/addon-fit.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/addon-fit.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.css") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.css`,
        contentType: "text/css; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-path-link",
          resumeToken: "resume-path-link",
          fileViewerToken: "viewer-path-link",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { active: true, leaseId: "lease-path-link" } });
    }
    if (url.pathname === "/remote/v1/session/release") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      return route.fulfill({ json: navigation });
    }
    if (/^\/remote\/v1\/terminals\/terminal-[12]\/focus$/.test(url.pathname)) {
      return route.fulfill({ json: { focused: url.pathname.split("/").at(-2) } });
    }
    if (/^\/remote\/v1\/terminals\/terminal-[12]\/resize$/.test(url.pathname)) {
      return route.fulfill({ json: { resized: true } });
    }
    if (url.pathname === "/remote/v1/file-viewer/status") {
      return route.fulfill({ json: { open: false, path: null } });
    }
    if (url.pathname === "/remote/v1/file-viewer/path-link") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      pathLinkRequests.push({
        authorization: await request.headerValue("authorization"),
        lease: await request.headerValue("x-laymux-remote-lease"),
        capability: await request.headerValue("x-laymux-remote-file-viewer"),
        body,
      });
      const hold = nextPathLinkHold;
      nextPathLinkHold = null;
      if (hold) {
        hold.started.resolve();
        await hold.release.promise;
        hold.resumed.resolve();
        // The page intentionally aborts an obsolete validation request. Mirror
        // a real server observing that disconnected client instead of waiting
        // for Playwright to fulfill a response that can no longer be delivered.
        return route.abort();
      }
      return route.fulfill({
        json: {
          valid: true,
          token: "src/main.rs",
          path: "C:\\work\\src\\main.rs",
        },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      renderRequests.push(JSON.parse(request.postData() || "{}") as Record<string, unknown>);
      return route.fulfill({
        json: {
          kind: "text",
          path: "C:\\work\\src\\main.rs",
          content: "fn main() {}",
          truncated: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  for (const [terminalId, output] of [
    ["terminal-1", "src/main.rs\r\n"],
    ["terminal-2", "second terminal\r\n"],
  ] as const) {
    await page.routeWebSocket(new RegExp(`/remote/v1/terminals/${terminalId}/output`), (socket) => {
      const { header, payload } = snapshotFrames(output);
      socket.send(header);
      socket.send(payload);
    });
  }

  await page.goto("http://remote.test/remote/#token=remote-secret");
  await page.evaluate(() => {
    const target = window as CapturedTerminalWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      (window as CapturedTerminalWindow).__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as CapturedTerminalWindow).__remoteTerm?.buffer.active
            .getLine(0)
            ?.translateToString() || "",
      ),
    )
    .toContain("src/main.rs");

  // Exercise the real xterm mouse-selection path. The per-cell selection
  // events must settle into a single validation request on pointer-up.
  const screen = page.locator(".xterm-screen");
  const dragPathSelection = async () => {
    // Attach/switch schedules a second fit at 160 ms. Waiting past that window
    // keeps the cell geometry from changing halfway through the real drag.
    await page.waitForTimeout(200);
    const screenBox = await screen.boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const term = (window as CapturedTerminalWindow).__remoteTerm;
      return { cols: term?.cols || 1, rows: term?.rows || 1 };
    });
    const cellWidth = screenBox!.width / geometry.cols;
    const cellHeight = screenBox!.height / geometry.rows;
    const dragY = screenBox!.y + cellHeight / 2;
    await page.mouse.move(screenBox!.x + cellWidth * 0.2, dragY);
    await page.mouse.down();
    await page.mouse.move(screenBox!.x + cellWidth * ("src/main.rs".length - 0.2), dragY, {
      steps: "src/main.rs".length,
    });
    await page.mouse.up();
  };
  await dragPathSelection();
  await expect
    .poll(() =>
      page.evaluate(() => (window as CapturedTerminalWindow).__remoteTerm?.getSelection() || ""),
    )
    .toBe("src/main.rs");

  const decoration = page.locator(".remote-path-link-decoration");
  await expect(decoration).toBeVisible();
  await expect(decoration).toHaveCSS("border-bottom-style", "solid");
  expect(pathLinkRequests).toEqual([
    {
      authorization: "Bearer remote-secret",
      lease: "lease-path-link",
      capability: "viewer-path-link",
      body: { terminalId: "terminal-1", selection: "src/main.rs" },
    },
  ]);

  const box = await decoration.boundingBox();
  expect(box).not.toBeNull();
  const popupPromise = page.waitForEvent("popup");
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const popup = await popupPromise;

  await expect(popup.locator("#text")).toContainText("fn main() {}");
  expect(popup.url()).toBe("http://remote.test/remote/viewer/");
  await expect
    .poll(() => renderRequests)
    .toEqual([{ source: "path", path: "C:\\work\\src\\main.rs" }]);

  // A resize/reflow while the stat bridge is pending must cancel the old
  // validation and re-run it against the current xterm selection geometry.
  await popup.close();
  const resizeHold = holdNextPathLink();
  await page.evaluate(() => {
    const term = (window as CapturedTerminalWindow).__remoteTerm;
    term?.clearSelection();
    term?.select(0, 0, "src/main.rs".length);
  });
  await resizeHold.started.promise;
  await page.evaluate(() => {
    const term = (window as CapturedTerminalWindow).__remoteTerm;
    if (term && term.cols > 20) term.resize(term.cols - 1, term.rows);
  });
  await expect.poll(() => pathLinkRequests.length).toBe(3);
  await expect(decoration).toBeVisible();
  resizeHold.release.resolve();
  await resizeHold.resumed.promise;
  await expect(decoration).toHaveCount(1);

  // Switching terminals aborts the pending request even when it was validating
  // the same selected text and otherwise valid path.
  await page.evaluate(() => {
    (window as CapturedTerminalWindow).__remoteTerm?.clearSelection();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as CapturedTerminalWindow).__remoteTerm?.getSelection() || ""),
    )
    .toBe("");
  const terminalSwitchHold = holdNextPathLink();
  await dragPathSelection();
  await expect
    .poll(() =>
      page.evaluate(() => (window as CapturedTerminalWindow).__remoteTerm?.getSelection() || ""),
    )
    .toBe("src/main.rs");
  await expect.poll(() => pathLinkRequests.length, { timeout: 5_000 }).toBe(4);
  await terminalSwitchHold.started.promise;
  await page.locator("#navToggle").click();
  await page.locator(".workspace-pane-row").nth(1).click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 2");
  terminalSwitchHold.release.resolve();
  await terminalSwitchHold.resumed.promise;
  await expect(decoration).toHaveCount(0);

  // Return to the first terminal for the lease-revocation case.
  await page.locator("#navToggle").click();
  await page.locator(".workspace-pane-row").nth(0).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as CapturedTerminalWindow).__remoteTerm?.buffer.active
            .getLine(0)
            ?.translateToString() || "",
      ),
    )
    .toContain("src/main.rs");

  // Releasing the controller lease aborts a pending validation and must not
  // leave a stale decoration or clickable path.
  const releaseHold = holdNextPathLink();
  await dragPathSelection();
  await releaseHold.started.promise;
  await page.locator("#navToggle").click();
  await page.locator("#release").click();
  releaseHold.release.resolve();
  await releaseHold.resumed.promise;
  await expect(decoration).toHaveCount(0);
  await expect(page.locator("#terminal")).not.toHaveClass(/remote-path-link-clickable/);
});
