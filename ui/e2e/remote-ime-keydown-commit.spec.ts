import { devices, expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

const appearance = { fontFamily: "monospace", fontSize: 14, theme: {} };
const pane = {
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
  w: 1,
  h: 1,
};

async function prepare(page: Page, writes: string[]) {
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/remote/v1/session/claim" || path === "/remote/v1/session/heartbeat") {
      return route.fulfill({
        json: { active: true, leaseId: "lease-1", heartbeatTimeoutSeconds: 45 },
      });
    }
    if (path === "/remote/v1/navigation") {
      return route.fulfill({
        json: {
          activeWorkspace: { id: "ws-1", name: "Main", panes: [pane] },
          workspaces: [
            {
              id: "ws-1",
              name: "Main",
              isActive: true,
              hidden: false,
              collapsed: false,
              paneCount: 1,
              terminalPaneCount: 1,
              liveTerminalCount: 1,
              unreadCount: 0,
              panes: [],
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
              appearance,
            },
          ],
          workspaceSelector: { display: {}, pathEllipsis: "start" },
          notifications: [],
          unreadNotificationCount: 0,
        },
      });
    }
    if (path === "/remote/v1/terminals/terminal-1/write")
      writes.push(route.request().postDataJSON().data);
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const payload = Buffer.from("ready\r\n", "utf8");
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
  await page.addInitScript(() => localStorage.setItem("laymux.remote.inputMode", "direct"));
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.evaluate(() => {
    const target = window as TermWindow;
    const original = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function () {
      (window as TermWindow).__remoteTerm = this as never;
      return original.call(this);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1", { timeout: 15000 });
  await page.clock.install({ time: new Date("2026-09-27T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T00:00:01Z"));
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { textarea: HTMLTextAreaElement };
  __imeTrace?: unknown[];
  __imeOnData?: string[];
};

// Exercise the Remote direct-input bundle in Android Chromium's browser profile.
// Native Android IME timing still needs device evidence.
test.describe("Remote direct-input composition interrupted by a physical key", () => {
  test.use({
    userAgent: devices["Pixel 7"].userAgent,
    viewport: devices["Pixel 7"].viewport,
    isMobile: true,
    hasTouch: true,
  });

  for (const inputOrder of ["space-before-end", "end-before-space"] as const) {
    for (const timerGap of [0, 1, 20]) {
      test(`${inputOrder}; ${timerGap}ms timer gap`, async ({ page }) => {
        const writes: string[] = [];
        await prepare(page, writes);
        await page.evaluate(() => {
          const term = (window as TermWindow).__remoteTerm!;
          const data: string[] = [];
          (window as TermWindow).__imeOnData = data;
          (term as typeof term & { onData: (listener: (value: string) => void) => void }).onData(
            (value) => data.push(value),
          );
          const textarea = term.textarea;
          textarea.focus();
          textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          textarea.value = "이미";
          textarea.dispatchEvent(
            new CompositionEvent("compositionupdate", { data: "이미", bubbles: true }),
          );
        });
        // compositionupdate captures its textarea end position in a timer.
        await page.clock.runFor(1);
        await page.evaluate((order) => {
          const textarea = (window as TermWindow).__remoteTerm!.textarea;
          if (order === "end-before-space") {
            textarea.dispatchEvent(
              new CompositionEvent("compositionend", { data: "이미", bubbles: true }),
            );
          }
          const event = new KeyboardEvent("keydown", {
            key: " ",
            code: "Space",
            keyCode: 32,
            which: 32,
            bubbles: true,
            cancelable: true,
          });
          textarea.dispatchEvent(event);
        }, inputOrder);
        if (timerGap) await page.clock.runFor(timerGap);
        if (inputOrder === "space-before-end") {
          await page.evaluate(() => {
            const textarea = (window as TermWindow).__remoteTerm!.textarea;
            textarea.dispatchEvent(
              new CompositionEvent("compositionend", { data: "이미", bubbles: true }),
            );
          });
        }
        await page.clock.runFor(100);
        await expect.poll(() => writes.length).toBeGreaterThan(0);
        const data = await page.evaluate(() => (window as TermWindow).__imeOnData!);
        // HTTP batching may differ; all emitted terminal data must reach the endpoint.
        await expect.poll(() => writes.join("")).toBe(data.join(""));
        // Synthetic keydown alone does not trigger Space's keypress/default action.
        expect(writes.join("")).toBe("이미");
      });
    }
  }

  test("Chromium default Space insertion and a later IME commit reach HTTP exactly once", async ({
    page,
    context,
  }) => {
    const writes: string[] = [];
    await prepare(page, writes);
    await page.locator(".xterm-helper-textarea").focus();
    await page.evaluate(() => {
      const textarea = (window as TermWindow).__remoteTerm!.textarea;
      const trace: unknown[] = [];
      (window as TermWindow).__imeTrace = trace;
      for (const name of [
        "keydown",
        "keypress",
        "compositionstart",
        "compositionupdate",
        "compositionend",
        "input",
      ]) {
        textarea.addEventListener(
          name,
          (event) =>
            trace.push({
              type: event.type,
              trusted: event.isTrusted,
              data:
                event instanceof CompositionEvent || event instanceof InputEvent
                  ? event.data
                  : undefined,
              keyCode: event instanceof KeyboardEvent ? event.keyCode : undefined,
              value: textarea.value,
            }),
          { capture: true },
        );
      }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "이미", selectionStart: 2, selectionEnd: 2 });
    await page.clock.runFor(10);
    await page.keyboard.press("Space");
    await cdp.send("Input.insertText", { text: "이미" });
    await page.clock.runFor(100);
    const trace = await page.evaluate(() => (window as TermWindow).__imeTrace);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compositionstart", trusted: true }),
        expect.objectContaining({ type: "keydown", keyCode: 32, trusted: true }),
        // CDP commits through the browser, but Chromium marks this end event untrusted.
        expect.objectContaining({ type: "compositionend", data: "이미" }),
      ]),
    );
    await expect.poll(() => writes.length).toBeGreaterThan(0);
    await expect.poll(() => writes.join("")).toBe("이미 ");
  });
});
