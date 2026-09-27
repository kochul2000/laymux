import { devices, expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

/**
 * ADR-0171: in Direct mode the IME preedit must occupy the same cells the
 * committed text will.
 *
 * xterm's DOM renderer letter-spaces every committed glyph onto its cells, but
 * its composition view lays the composing string out at the font's natural
 * advance — a Hangul syllable renders ~1 cell wide and then jumps to 2 on
 * commit. Measured here in a real browser because the defect is a layout
 * measurement: a jsdom test cannot advance a glyph.
 */

const APPEARANCE = {
  fontFamily: "monospace",
  fontSize: 14,
  cursorStyle: "bar",
  cursorWidth: 1,
  theme: {},
};

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
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
        w: 1,
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
      appearance: APPEARANCE,
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

function snapshotFrames(text: string) {
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

async function installRemoteMocks(
  page: Page,
  writes: string[] = [],
  writeDelayMs = 0,
  firstWrite?: Promise<void>,
) {
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({
        json: { active: true, leaseId: "lease-1", heartbeatTimeoutSeconds: 45 },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigation });
      return;
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/write") {
      writes.push(route.request().postDataJSON().data);
      if (writes.length === 1) await firstWrite;
      if (writeDelayMs) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const snapshot = snapshotFrames("ready\r\n");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    cols: number;
    element: HTMLElement;
    textarea: HTMLTextAreaElement;
  };
};

async function connectRemote(page: Page) {
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.evaluate(() => {
    const target = window as TermWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      (window as TermWindow).__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1", { timeout: 15000 });
}

/**
 * Drive one composition through xterm's own textarea listeners and report the
 * preedit boxes in cells.
 */
function composePreedit(page: Page, text: string) {
  return page.evaluate((composing) => {
    const term = (window as TermWindow).__remoteTerm;
    if (!term) throw new Error("terminal instance was not captured");
    const screen = term.element.querySelector(".xterm-screen") as HTMLElement;
    const view = term.element.querySelector(".composition-view") as HTMLElement;
    const cellWidth = screen.getBoundingClientRect().width / term.cols;
    term.textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    term.textarea.value = composing;
    term.textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: composing }));
    return {
      cellWidth,
      active: view.classList.contains("active"),
      viewCells: view.getBoundingClientRect().width / cellWidth,
      boxCells: Array.from(
        view.children,
        (child) => child.getBoundingClientRect().width / cellWidth,
      ),
      boxTexts: Array.from(view.children, (child) => child.textContent ?? ""),
    };
  }, text);
}

/**
 * Box widths come back as pixel rects divided by a fractional cell width, so
 * they land within a rounding step of the whole cell counts — near enough to
 * separate a correctly sized box from the ~1-cell natural advance this fixes.
 */
function expectCells(measured: number[], expected: number[]) {
  expect(measured).toHaveLength(expected.length);
  measured.forEach((cells, index) => expect(cells).toBeCloseTo(expected[index], 2));
}

test.describe("remote direct-mode IME preedit", () => {
  test.beforeEach(async ({ page }) => {
    await installRemoteMocks(page);
    await connectRemote(page);
  });

  test("puts a composing wide syllable on the two cells it will commit to", async ({ page }) => {
    const preedit = await composePreedit(page, "한");

    expect(preedit.active).toBe(true);
    expect(preedit.cellWidth).toBeGreaterThan(0);
    expect(preedit.boxTexts).toEqual(["한"]);
    expectCells(preedit.boxCells, [2]);
    expect(preedit.viewCells).toBeCloseTo(2, 1);
  });

  test("keeps each cluster on its own cells in a mixed-width preedit", async ({ page }) => {
    const preedit = await composePreedit(page, "a한b");

    expect(preedit.boxTexts).toEqual(["a", "한", "b"]);
    expectCells(preedit.boxCells, [1, 2, 1]);
    expect(preedit.viewCells).toBeCloseTo(4, 1);
  });

  test("clears the preedit boxes when the composition ends", async ({ page }) => {
    await composePreedit(page, "한");
    const cleared = await page.evaluate(() => {
      const term = (window as TermWindow).__remoteTerm;
      if (!term) throw new Error("terminal instance was not captured");
      term.textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한" }));
      const view = term.element.querySelector(".composition-view") as HTMLElement;
      return { children: view.children.length, active: view.classList.contains("active") };
    });

    expect(cleared).toEqual({ children: 0, active: false });
  });
});

// Drive the shipped Remote bundle through its DOM listeners and observe the
// actual /write bodies. Holding timers makes the composition finalizer race
// deterministic; delaying HTTP separately distinguishes event duplication from
// transport retries. Real OS IME event timing still needs device verification.
test.describe("remote direct-mode IME delivery", () => {
  test.use({
    userAgent: devices["Pixel 7"].userAgent,
    viewport: devices["Pixel 7"].viewport,
    isMobile: true,
    hasTouch: true,
  });

  async function prepare(page: Page, writeDelayMs = 0, firstWrite?: Promise<void>) {
    const writes: string[] = [];
    await installRemoteMocks(page, writes, writeDelayMs, firstWrite);
    await page.addInitScript(() => localStorage.setItem("laymux.remote.inputMode", "direct"));
    await connectRemote(page);
    await page.clock.install({ time: new Date("2026-09-27T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-27T00:00:01Z"));
    return writes;
  }

  async function commitWords(page: Page, words: string[], propagatedKeypress = false) {
    return page.evaluate(
      ({ words, propagatedKeypress }) => {
        const textarea = (window as TermWindow).__remoteTerm!.textarea;
        textarea.focus();
        const prevented: boolean[] = [];
        for (const word of words) {
          textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          textarea.value += word;
          textarea.dispatchEvent(
            new CompositionEvent("compositionupdate", { data: word, bubbles: true }),
          );
          textarea.dispatchEvent(
            new CompositionEvent("compositionend", { data: word, bubbles: true }),
          );
          textarea.dispatchEvent(
            new InputEvent("input", { data: word, inputType: "insertText", bubbles: true }),
          );
          if (propagatedKeypress) {
            const key = word.at(-1)!;
            const event = new KeyboardEvent("keypress", {
              key,
              charCode: key.charCodeAt(0),
              bubbles: true,
              cancelable: true,
            });
            textarea.dispatchEvent(event);
            prevented.push(event.defaultPrevented);
            // Synthetic keypress has no default edit; model the browser insertion
            // only if xterm failed to consume the propagated observation.
            if (!event.defaultPrevented) textarea.value += key;
          }
        }
        return prevented;
      },
      { words, propagatedKeypress },
    );
  }

  for (const writeDelayMs of [0, 150]) {
    test(`sends a committed word once with ${writeDelayMs}ms HTTP delay`, async ({ page }) => {
      const writes = await prepare(page, writeDelayMs);
      await commitWords(page, ["키보드를"]);
      await page.clock.runFor(50);
      await expect.poll(() => writes.join("")).toBe("키보드를");
      await page.clock.runFor(1000);
      expect(writes).toEqual(["키보드를"]);
    });
  }

  test("consumes the legacy keypress that propagates a committed syllable", async ({ page }) => {
    const writes = await prepare(page);
    expect(await commitWords(page, ["키보드를"], true)).toEqual([true]);
    await page.clock.runFor(50);
    await expect.poll(() => writes).toEqual(["키보드를"]);
  });

  test("preserves intentionally repeated words in separate pending compositions", async ({
    page,
  }) => {
    const writes = await prepare(page);
    await commitWords(page, ["그렇게 ", "그렇게 "]);
    await page.clock.runFor(50);
    await expect.poll(() => writes.join("")).toBe("그렇게 그렇게 ");
  });

  test("preserves the next word while an earlier HTTP write is still pending", async ({ page }) => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes = await prepare(page, 0, firstWrite);
    try {
      await commitWords(page, ["키보드를 "]);
      await page.clock.runFor(50);
      await expect.poll(() => writes).toEqual(["키보드를 "]);
      await commitWords(page, ["쓸때도"]);
      await page.clock.runFor(50);
      expect(writes).toEqual(["키보드를 "]);
    } finally {
      releaseFirst();
    }
    await expect.poll(() => writes).toEqual(["키보드를 ", "쓸때도"]);
  });

  test("flushes a committed word once before blur clears the helper", async ({ page }) => {
    const writes = await prepare(page);
    await commitWords(page, ["나오는데"]);
    await page.evaluate(() => (window as TermWindow).__remoteTerm!.textarea.blur());
    await page.clock.runFor(50);
    await expect.poll(() => writes).toEqual(["나오는데"]);
  });
});
