import { expect, test, type Page } from "@playwright/test";

import { remoteClientMarkupWithoutXterm } from "./remote-client-assets";

type InputRequest = {
  body: { leaseId: string; text: string; submit: boolean };
  respond: (status?: number) => Promise<void>;
};

type FocusRequest = {
  terminalId: string;
  respond: () => Promise<void>;
};

type NavigationRequest = {
  respond: () => Promise<void>;
};

type RemoteState = {
  inputs: InputRequest[];
  writes: Array<{ leaseId: string; data: string }>;
  focuses: FocusRequest[];
  navigations: NavigationRequest[];
  claims: Array<{ clientName?: string; claimReservationId?: string }>;
  starredEntries: string[];
};

const pane = (terminalId: string, paneNumber: number, cwd: string, isFocused: boolean) => ({
  id: `pane-${paneNumber}`,
  location: "workspace",
  workspaceId: "ws-1",
  paneIndex: paneNumber - 1,
  paneNumber,
  viewType: "TerminalView",
  terminalId,
  terminalLive: true,
  title: `Shell ${paneNumber}`,
  profile: "PowerShell",
  cwd,
  branch: "main",
  activity: { type: "shell" },
  outputActive: false,
  commandRunning: false,
  isFocused,
  unreadCount: 0,
  hidden: false,
  collapsed: false,
  x: 0,
  y: paneNumber - 1,
  w: 1,
  h: 0.5,
});

const panes = [pane("terminal-1", 1, "C:\\one", true), pane("terminal-2", 2, "C:\\two", false)];

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    focusedPaneNumber: 1,
    panes,
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
      panes,
    },
  ],
  docks: [],
  terminals: [
    {
      id: "terminal-1",
      title: "Shell 1",
      profile: "PowerShell",
      cwd: "C:\\one",
      workspaceId: "ws-1",
      paneNumber: 1,
      appearance: {},
    },
    {
      id: "terminal-2",
      title: "Shell 2",
      profile: "PowerShell",
      cwd: "C:\\two",
      workspaceId: "ws-1",
      paneNumber: 2,
      appearance: {},
    },
  ],
  workspaceSelector: { display: { path: true, environment: true }, pathEllipsis: "end" },
  notifications: [],
  unreadNotificationCount: 0,
};

async function installBrowserMocks(
  page: Page,
  options: {
    coarse: boolean;
    storedMode?: "direct" | "composer";
    legacyOutput?: boolean;
    delayTerminal1Snapshot?: boolean;
    delayTerminal2Snapshot?: boolean;
    delayFirstTerminalWrite?: boolean;
    deferSocketCloseEvent?: boolean;
    failTerminalConstruction?: boolean;
    lateTerminalFocusAfterTouchTap?: boolean;
    virtualKeyboardHeight?: number;
  },
) {
  await page.addInitScript(
    ({
      coarse,
      storedMode,
      legacyOutput,
      delayTerminal1Snapshot,
      delayTerminal2Snapshot,
      delayFirstTerminalWrite,
      deferSocketCloseEvent,
      failTerminalConstruction,
      lateTerminalFocusAfterTouchTap,
      virtualKeyboardHeight,
    }) => {
      if (storedMode) localStorage.setItem("laymux.remote.inputMode", storedMode);
      else localStorage.removeItem("laymux.remote.inputMode");

      const nativeMatchMedia = window.matchMedia.bind(window);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => {
          if (query !== "(pointer: coarse)") return nativeMatchMedia(query);
          return {
            matches: coarse,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() {
              return true;
            },
          };
        },
      });

      if (virtualKeyboardHeight !== undefined) {
        Object.defineProperty(navigator, "virtualKeyboard", {
          configurable: true,
          value: { boundingRect: { height: virtualKeyboardHeight } },
        });
      }

      class MockTerminal {
        options: Record<string, unknown>;
        modes = {
          applicationCursorKeysMode: false,
          bracketedPasteMode: false,
          mouseTrackingMode: "none",
        };
        cols = 80;
        rows = 24;
        element: HTMLElement | null = null;
        textarea: HTMLTextAreaElement | null = null;
        buffer = {
          active: {
            type: "normal",
            baseY: 0,
            viewportY: 0,
            ydisp: 0,
            length: 24,
            getLine: () => null,
          },
        };
        selection = "";
        written: Array<string | Uint8Array> = [];
        appliedColorSetters: Array<{ ident: number; data: string }> = [];
        _core = {
          _inputHandler: {
            setOrReportIndexedColor: (data: string) => this.applyColorSetter(4, data),
            setOrReportFgColor: (data: string) => this.applyColorSetter(10, data),
            setOrReportBgColor: (data: string) => this.applyColorSetter(11, data),
            setOrReportCursorColor: (data: string) => this.applyColorSetter(12, data),
          },
        };
        parser = {
          csiHandlers: [] as Array<{ prefix?: string; intermediates?: string; final: string }>,
          oscHandlers: [] as Array<{
            ident: number;
            handler: (data: string) => boolean;
          }>,
          registerCsiHandler(
            id: { prefix?: string; intermediates?: string; final: string },
            _handler: () => boolean,
          ) {
            this.csiHandlers.push(id);
            return { dispose() {} };
          },
          registerOscHandler(ident: number, handler: (data: string) => boolean) {
            this.oscHandlers.push({ ident, handler });
            return { dispose() {} };
          },
        };
        private dataListener: ((data: string) => void) | null = null;
        private resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
        private scrollListener: (() => void) | null = null;
        private delayNextWrite = Boolean(delayFirstTerminalWrite);
        private delayedWriteCallback: (() => void) | null = null;

        constructor(options: Record<string, unknown>) {
          if (failTerminalConstruction) throw new Error("xterm constructor failed");
          this.options = { ...options };
          Object.defineProperty(window, "__mockTerminal", {
            value: this,
            configurable: true,
          });
        }

        loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
          addon.activate?.(this);
        }

        open(host: HTMLElement) {
          const element = document.createElement("div");
          element.className = "xterm";
          const screen = document.createElement("div");
          screen.className = "xterm-screen";
          const textarea = document.createElement("textarea");
          textarea.className = "xterm-helper-textarea";
          screen.append(textarea);
          element.append(screen);
          element.addEventListener("mousedown", () => textarea.focus());
          if (lateTerminalFocusAfterTouchTap) {
            // Android can deliver xterm's compatibility focus after the touch
            // bridge has handled pointerup. Model that late focus theft in the
            // gesture's next frame so the Composer handoff must outlive one call.
            element.addEventListener("pointerup", (event) => {
              if (event.pointerType !== "touch") return;
              requestAnimationFrame(() => {
                textarea.dataset.lateTouchFocus = "true";
                textarea.focus();
              });
            });
          }
          host.append(element);
          this.element = element;
          this.textarea = textarea;
        }

        onData(listener: (data: string) => void) {
          this.dataListener = listener;
        }

        onResize(listener: (size: { cols: number; rows: number }) => void) {
          this.resizeListener = listener;
        }

        onSelectionChange(_listener: () => void) {}
        onScroll(listener: () => void) {
          this.scrollListener = listener;
        }
        hasSelection() {
          return Boolean(this.selection);
        }
        getSelection() {
          return this.selection;
        }
        getSelectionPosition() {
          return null;
        }
        clearSelection() {
          this.selection = "";
        }
        select(_column: number, _row: number, _length: number) {}
        reset() {
          this.written = [];
        }
        refresh(_start: number, _end: number) {}
        write(data: string | Uint8Array, callback?: () => void) {
          this.written.push(data);
          if (this.delayNextWrite) {
            this.delayNextWrite = false;
            this.delayedWriteCallback = callback ?? null;
            return;
          }
          callback?.();
        }
        private applyColorSetter(ident: number, data: string) {
          this.appliedColorSetters.push({ ident, data });
          return true;
        }
        releaseDelayedWrite() {
          const callback = this.delayedWriteCallback;
          this.delayedWriteCallback = null;
          callback?.();
        }
        focus() {
          this.textarea?.focus({ preventScroll: true });
        }
        blur() {
          this.textarea?.blur();
        }
        scrollCalls: number[] = [];
        scrollLines(amount: number) {
          this.scrollCalls.push(amount);
          const active = this.buffer.active;
          active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + amount));
          active.ydisp = active.viewportY;
          this.scrollListener?.();
        }
        scrollToBottom() {
          this.scrollCalls.push(Number.POSITIVE_INFINITY);
          const active = this.buffer.active;
          active.viewportY = active.baseY;
          active.ydisp = active.baseY;
          this.scrollListener?.();
        }
        setViewport(baseY: number, viewportY: number) {
          const active = this.buffer.active;
          active.baseY = Math.max(0, baseY);
          active.viewportY = Math.max(0, Math.min(active.baseY, viewportY));
          active.ydisp = active.viewportY;
          this.scrollListener?.();
        }
        emitData(data: string) {
          this.dataListener?.(data);
        }
        // Simulate xterm parsing a CSI query out of streamed output: it emits
        // the reply via onData unless a registered handler claims the sequence.
        emitCsiQueryReply(
          id: { prefix?: string; intermediates?: string; final: string },
          reply: string,
        ) {
          const suppressed = this.parser.csiHandlers.some(
            (handler) =>
              (handler.prefix ?? "") === (id.prefix ?? "") &&
              (handler.intermediates ?? "") === (id.intermediates ?? "") &&
              handler.final === id.final,
          );
          if (suppressed) return;
          this.dataListener?.(reply);
        }
        emitOscQueryReply(ident: number, data: string, reply: string) {
          if (this.isOscHandled(ident, data)) return;
          this.dataListener?.(reply);
        }
        isOscHandled(ident: number, data: string) {
          return [...this.parser.oscHandlers]
            .reverse()
            .some((entry) => entry.ident === ident && entry.handler(data));
        }
        emitResize() {
          this.resizeListener?.({ cols: this.cols, rows: this.rows });
        }
      }

      class MockFitAddon {
        terminal: MockTerminal | null = null;
        activate(terminal: MockTerminal) {
          this.terminal = terminal;
        }
        fit() {
          this.terminal?.emitResize();
        }
      }

      class MockResizeObserver {
        observe(_target: Element) {}
        disconnect() {}
      }

      class MockWebSocket {
        binaryType = "";
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        closed = false;
        readonly url: string;

        constructor(url: string) {
          this.url = url;
          (window as Window & { __mockSockets?: MockWebSocket[] }).__mockSockets?.push(this);
          setTimeout(() => {
            if (this.closed) return;
            this.onopen?.();
            if (legacyOutput) {
              this.onmessage?.(
                new MessageEvent("message", {
                  data: new TextEncoder().encode("legacy output").buffer,
                }),
              );
              return;
            }
            if (
              (delayTerminal1Snapshot && url.includes("/terminals/terminal-1/output")) ||
              (delayTerminal2Snapshot && url.includes("/terminals/terminal-2/output"))
            ) {
              return;
            }
            this.emitSnapshot();
          }, 0);
        }

        emitSnapshot() {
          if (this.closed) return;
          const header = {
            type: "terminal.output",
            version: 1,
            phase: "snapshot",
            seqStart: 0,
            seqEnd: 0,
            byteLength: 0,
            state: {
              version: 1,
              snapshotStartSeq: 0,
              snapshotSeq: 0,
              protocolRevision: 0,
              modes: { bracketedPaste: false },
            },
          };
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(header) }));
          this.onmessage?.(new MessageEvent("message", { data: new ArrayBuffer(0) }));
        }

        emitText(data: string) {
          if (this.closed) return;
          this.onmessage?.(new MessageEvent("message", { data }));
        }

        close() {
          if (this.closed) return;
          this.closed = true;
          if (deferSocketCloseEvent) return;
          this.onclose?.();
        }
      }

      Object.defineProperty(window, "Terminal", { value: MockTerminal, configurable: true });
      Object.defineProperty(window, "FitAddon", {
        value: { FitAddon: MockFitAddon },
        configurable: true,
      });
      Object.defineProperty(window, "ResizeObserver", {
        value: MockResizeObserver,
        configurable: true,
      });
      Object.defineProperty(window, "__mockSockets", {
        value: [] as MockWebSocket[],
        configurable: true,
      });
      Object.defineProperty(window, "WebSocket", {
        value: MockWebSocket,
        configurable: true,
      });
    },
    options,
  );
}

async function installRemotePage(
  page: Page,
  options: {
    coarse: boolean;
    localApp?: boolean;
    storedMode?: "direct" | "composer";
    activeAgent?: "Claude" | "Codex" | "Grok";
    holdInputs?: boolean;
    holdTerminalFocus?: boolean;
    holdInitialNavigation?: boolean;
    legacyOutput?: boolean;
    delayTerminal1Snapshot?: boolean;
    delayTerminal2Snapshot?: boolean;
    delayFirstTerminalWrite?: boolean;
    deferSocketCloseEvent?: boolean;
    failTerminalConstruction?: boolean;
    lateTerminalFocusAfterTouchTap?: boolean;
    virtualKeyboardHeight?: number;
    claimBusyResponses?: number;
    claimRetryAfterMs?: number;
    claimReservationTtlMs?: number;
    width?: number;
    starredEntries?: string[];
  },
): Promise<RemoteState> {
  const state: RemoteState = {
    inputs: [],
    writes: [],
    focuses: [],
    navigations: [],
    claims: [],
    starredEntries: [...(options.starredEntries ?? [])],
  };
  let remainingClaimBusyResponses = options.claimBusyResponses ?? 0;
  await page.setViewportSize({ width: options.width ?? 390, height: 844 });
  await installBrowserMocks(page, options);
  await page.route(
    (url) => url.origin === "http://remote.test" && url.pathname === "/",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
  );
  await page.route("**/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      const body = route.request().postDataJSON() as {
        clientName?: string;
        claimReservationId?: string;
      };
      state.claims.push(body);
      if (remainingClaimBusyResponses > 0) {
        remainingClaimBusyResponses -= 1;
        await route.fulfill({
          status: 409,
          json: {
            error: "terminal input is busy",
            code: "input_busy",
            claimReservationId: "reservation-1",
            retryAfterMs: options.claimRetryAfterMs ?? 10,
            reservationTtlMs: options.claimReservationTtlMs ?? 2_000,
          },
        });
        return;
      }
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
      return;
    }
    if (url.pathname === "/remote/v1/composer/starred") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          text: string;
          starred: boolean;
        };
        state.starredEntries = body.starred
          ? [...new Set([...state.starredEntries, body.text])]
          : state.starredEntries.filter((entry) => entry !== body.text);
      }
      await route.fulfill({ json: { entries: state.starredEntries } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      const navigationWithActivity = structuredClone(navigation);
      if (options.activeAgent) {
        const updateActivity = (items: typeof panes) => {
          items[0].activity = { type: "interactiveApp", name: options.activeAgent };
        };
        updateActivity(navigationWithActivity.activeWorkspace.panes);
        updateActivity(navigationWithActivity.workspaces[0].panes);
      }
      if (options.holdInitialNavigation && state.navigations.length === 0) {
        await new Promise<void>((done) => {
          state.navigations.push({
            respond: async () => {
              await route.fulfill({ json: navigationWithActivity });
              done();
            },
          });
        });
        return;
      }
      await route.fulfill({ json: navigationWithActivity });
      return;
    }
    if (url.pathname.endsWith("/input")) {
      const body = route.request().postDataJSON() as InputRequest["body"];
      if (!options.holdInputs) {
        state.inputs.push({ body, respond: async () => {} });
        await route.fulfill({ json: { ok: true } });
        return;
      }
      await new Promise<void>((done) => {
        state.inputs.push({
          body,
          respond: async (status = 200) => {
            if (status >= 400) {
              await route.fulfill({ status, json: { error: "input failed" } });
            } else {
              await route.fulfill({ status, json: { ok: true } });
            }
            done();
          },
        });
      });
      return;
    }
    if (url.pathname.endsWith("/focus") && options.holdTerminalFocus) {
      const terminalId = url.pathname.split("/").at(-2) ?? "";
      await new Promise<void>((done) => {
        state.focuses.push({
          terminalId,
          respond: async () => {
            await route.fulfill({ json: { ok: true } });
            done();
          },
        });
      });
      return;
    }
    if (url.pathname.endsWith("/write")) {
      state.writes.push(route.request().postDataJSON() as RemoteState["writes"][number]);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  // setContent keeps the URL, so the page script still reads localApp=1
  // from location.search at init (ADR-0036 layout classification).
  await page.goto(options.localApp ? "http://remote.test/?localApp=1" : "http://remote.test/");
  await page.setContent(remoteClientMarkupWithoutXterm());
  return state;
}

async function connect(page: Page) {
  await page.locator("#token").fill("test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
}

async function selectTerminal(page: Page, cwd: string) {
  await page.locator("#navToggle").click();
  await page.locator(".workspace-pane-row", { hasText: cwd }).click();
}

async function dispatchTerminalPaste(page: Page, text: string) {
  await page.locator("#terminal .xterm").evaluate((element, pastedText) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? pastedText : ""),
      },
    });
    element.dispatchEvent(event);
  }, text);
}

async function clickInputModeToggle(page: Page) {
  const toggle = page.locator("#inputModeToggle");
  if (!(await toggle.isVisible())) {
    await page.locator("#keyBarToggle").click();
  }
  await toggle.click();
}

async function openRemoteSettings(page: Page) {
  const navigationToggle = page.locator("#navToggle");
  const settings = page.locator("#drawerSettingsButton");
  if ((await navigationToggle.getAttribute("aria-expanded")) !== "true") {
    await navigationToggle.click();
  }
  await settings.click();
  await expect(page.locator("#drawerSettingsView")).toBeVisible();
  // Settings is paginated; the composer toggles live on their own tab.
  await page.locator('#settingsTabs [data-settings-panel="composer"]').click();
  await expect(page.locator("#settingsPanelComposer")).toBeVisible();
}

async function expectedComposerHiddenDistance(page: Page, configuredLines: number) {
  await expect(page.locator("#terminal .xterm-screen")).toBeVisible();
  await expect(page.locator("#terminalComposer")).toBeVisible();
  const hiddenLines = await page.evaluate((lines) => {
    const mock = window as typeof window & { __mockTerminal?: { rows: number } };
    const screen = document.querySelector<HTMLElement>("#terminal .xterm-screen");
    const composer = document.querySelector<HTMLElement>("#terminalComposer");
    const rows = mock.__mockTerminal?.rows ?? 0;
    if (!screen || !composer || rows <= 0) return lines;
    const terminalRect = screen.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const overlap = Math.max(
      0,
      Math.min(terminalRect.bottom, composerRect.bottom) -
        Math.max(terminalRect.top, composerRect.top),
    );
    const cellHeight = terminalRect.height / rows;
    const coveredLines = cellHeight > 0 ? Math.ceil(overlap / cellHeight) : 0;
    return Math.max(0, lines - coveredLines);
  }, configuredLines);
  return hiddenLines;
}

async function terminalScrollDistance(page: Page) {
  return page.evaluate(() => {
    const mock = window as typeof window & {
      __mockTerminal?: {
        buffer: { active: { baseY: number; viewportY: number } };
      };
    };
    const active = mock.__mockTerminal?.buffer.active;
    return active ? active.baseY - active.viewportY : -1;
  });
}

test("fine-pointer PC and coarse-pointer mobile can both toggle and persist the preferred mode", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: false, width: 1280 });

  const composer = page.locator("#terminalComposer");
  const toggle = page.locator("#inputModeToggle");
  await expect(composer).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await clickInputModeToggle(page);
  await expect(composer).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.inputMode")))
    .toBe("composer");

  const geometry = await page.locator(".terminal-shell").evaluate((shell) => {
    const terminal = shell.querySelector<HTMLElement>("#terminal")!.getBoundingClientRect();
    const editor = shell.querySelector<HTMLElement>("#terminalComposer")!.getBoundingClientRect();
    return {
      terminalTop: terminal.top,
      terminalBottom: terminal.bottom,
      editorTop: editor.top,
      editorBottom: editor.bottom,
    };
  });
  expect(geometry.editorTop).toBeGreaterThanOrEqual(geometry.terminalTop);
  expect(geometry.editorTop).toBeLessThan(geometry.terminalBottom);
  expect(geometry.editorBottom).toBeLessThanOrEqual(geometry.terminalBottom);

  // Re-running the static entry simulates a reload: preference survives, drafts do not.
  await page.setContent(remoteClientMarkupWithoutXterm());
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(page.locator("#inputModeToggle")).toHaveAttribute("aria-pressed", "true");
});

test("a busy Local input is claimed by retrying the one-shot reservation token", async ({
  page,
}) => {
  const state = await installRemotePage(page, {
    coarse: false,
    claimBusyResponses: 3,
    claimRetryAfterMs: 80,
    claimReservationTtlMs: 220,
    width: 1280,
  });

  await connect(page);

  expect(state.claims).toEqual([
    { clientName: "browser" },
    { clientName: "browser", claimReservationId: "reservation-1" },
    { clientName: "browser", claimReservationId: "reservation-1" },
    { clientName: "browser", claimReservationId: "reservation-1" },
  ]);
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
});

test("coarse pointer defaults to Composer and a saved Direct preference wins", async ({ page }) => {
  await installRemotePage(page, { coarse: true, storedMode: "direct" });
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await expect(page.locator("#inputModeToggle")).toHaveAttribute("aria-pressed", "false");

  await clickInputModeToggle(page);
  await expect(page.locator("#terminalComposer")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("terminal switches preserve isolated mode and draft state without persistence", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  await expect(editor).toBeEnabled();
  await editor.fill("draft one");

  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#terminalMeta")).toContainText("Shell 2");
  await expect(editor).toHaveValue("");
  await editor.fill("draft two");
  await clickInputModeToggle(page);
  await expect(page.locator("#terminalComposer")).toBeHidden();

  await selectTerminal(page, "C:\\one");
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(editor).toHaveValue("draft one");

  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await clickInputModeToggle(page);
  await expect(editor).toHaveValue("draft two");
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("Draft"))),
  ).toEqual([]);
});

test("a terminal switch isolates the old socket and readiness before delayed host focus", async ({
  page,
}) => {
  const remote = await installRemotePage(page, {
    coarse: true,
    holdTerminalFocus: true,
    delayTerminal2Snapshot: true,
  });
  await connect(page);
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");

  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#terminalMeta")).toContainText("Shell 2");
  await expect.poll(() => remote.focuses.length).toBe(1);
  expect(remote.focuses[0].terminalId).toBe("terminal-2");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __mockSockets: Array<{ url: string; closed: boolean }>;
            }
          ).__mockSockets.length,
      ),
    )
    .toBe(2);

  const sockets = await page.evaluate(() =>
    (
      window as Window & {
        __mockSockets: Array<{ url: string; closed: boolean }>;
      }
    ).__mockSockets.map(({ url, closed }) => ({ url, closed })),
  );
  expect(sockets).toHaveLength(2);
  expect(sockets[0]).toMatchObject({ closed: true });
  expect(sockets[0].url).toContain("/terminals/terminal-1/output");
  expect(sockets[1]).toMatchObject({ closed: false });
  expect(sockets[1].url).toContain("/terminals/terminal-2/output");
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");

  await remote.focuses[0].respond();
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");
  await page.evaluate(() => {
    const sockets = (
      window as Window & {
        __mockSockets: Array<{ emitSnapshot: () => void }>;
      }
    ).__mockSockets;
    sockets[1].emitSnapshot();
  });
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
});

test("fine-pointer Composer sends on Enter and keeps Shift+Enter as a newline", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await clickInputModeToggle(page);

  const editor = page.locator("#composerInput");
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
  // Send is a configurable action and remains available in Composer on every
  // layout; desktop Enter continues to provide the keyboard gesture too.
  await expect(page.locator("#composerSend")).toBeVisible();

  // The desktop keydown guards: Enter mid-composition (isComposing) and the
  // soft-keyboard keyCode 229 variant never submit.
  await editor.fill("한글 조합");
  await editor.dispatchEvent("compositionstart");
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await page.waitForTimeout(20);
  expect(remote.inputs).toHaveLength(0);
  await editor.dispatchEvent("compositionend");
  await editor.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });
  await page.waitForTimeout(20);
  expect(remote.inputs).toHaveLength(0);

  await editor.fill("line");
  await editor.press("Shift+Enter");
  await expect(editor).toHaveValue("line\n");
  expect(remote.inputs).toHaveLength(0);

  await editor.fill("send me");
  await editor.press("Enter");
  await expect.poll(() => remote.inputs.length).toBe(1);
  expect(remote.inputs[0].body).toEqual({
    leaseId: "lease-1",
    text: "send me",
    submit: true,
  });
  await expect(editor).toHaveValue("");
});

test("mobile-layout Composer keeps Enter as a newline and submits with the Send button", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
  // Mobile layout submits with the dedicated Send button only (ADR-0036).
  await expect(page.locator("#composerSend")).toBeVisible();

  // Enter — composing or not — never sends on the mobile layout.
  await editor.fill("한글 조합");
  await editor.dispatchEvent("compositionstart");
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await page.waitForTimeout(20);
  expect(remote.inputs).toHaveLength(0);
  await editor.dispatchEvent("compositionend");

  await editor.fill("line");
  await editor.press("Enter");
  await expect(editor).toHaveValue("line\n");
  expect(remote.inputs).toHaveLength(0);

  await editor.fill("send me");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  expect(remote.inputs[0].body).toEqual({
    leaseId: "lease-1",
    text: "send me",
    submit: true,
  });
  await expect(editor).toHaveValue("");

  await editor.fill("untouched draft");
  await page.locator('[data-key="c-c"]').click();
  await expect.poll(() => remote.writes.length).toBe(1);
  expect(remote.writes[0]).toEqual({ leaseId: "lease-1", data: "\x03" });
  await expect(editor).toHaveValue("untouched draft");

  await page.locator("#keyBarToggle").click();
  await page.locator('[data-key="esc"]').click();
  await expect.poll(() => remote.writes.length).toBe(2);
  expect(remote.writes[1].data).toBe("\x1b");
  await expect(editor).toHaveValue("untouched draft");
});

test("PC-app embedded mobile view (localApp=1) keeps the mobile send gesture on a fine pointer", async ({
  page,
}) => {
  const remote = await installRemotePage(page, {
    coarse: false,
    localApp: true,
    storedMode: "composer",
  });
  await connect(page);

  const editor = page.locator("#composerInput");
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
  // mobileLayout = coarse pointer || localApp=1 (ADR-0036): the embedded
  // mobile view behaves mobile even though it is driven by a mouse/keyboard.
  await expect(page.locator("#composerSend")).toBeVisible();

  await editor.fill("line");
  await editor.press("Enter");
  await expect(editor).toHaveValue("line\n");
  expect(remote.inputs).toHaveLength(0);

  await editor.fill("send me");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  expect(remote.inputs[0].body).toEqual({
    leaseId: "lease-1",
    text: "send me",
    submit: true,
  });
  await expect(editor).toHaveValue("");
});

test("Direct paste uses structured input only after a V1 snapshot establishes readiness", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false });
  await connect(page);

  await expect(page.locator("#terminalComposer")).toBeHidden();
  await dispatchTerminalPaste(page, "first\nsecond");
  await expect.poll(() => remote.inputs.length).toBe(1);
  expect(remote.inputs[0].body).toEqual({
    leaseId: "lease-1",
    text: "first\nsecond",
    submit: false,
  });
});

test("legacy unsequenced output remains visible but Composer and direct paste fail closed", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true, legacyOutput: true });
  await connect(page);

  await page.locator("#composerInput").fill("preserved draft");
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");
  await clickInputModeToggle(page);
  await dispatchTerminalPaste(page, "must not send");
  expect(remote.inputs).toHaveLength(0);
  await expect(page.locator("#status")).toHaveText("Terminal input is not ready.");
});

test("a malformed output frame stays fail-closed after a delayed snapshot write completes", async ({
  page,
}) => {
  await installRemotePage(page, {
    coarse: true,
    delayFirstTerminalWrite: true,
    deferSocketCloseEvent: true,
  });
  await connect(page);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __mockTerminal: { written: unknown[] } }).__mockTerminal.written
            .length,
      ),
    )
    .toBe(1);
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");

  await page.evaluate(() => {
    const socket = (
      window as Window & { __mockSockets: Array<{ emitText: (data: string) => void }> }
    ).__mockSockets[0];
    socket.emitText("{malformed");
  });
  await expect(page.locator("#status")).toHaveText("Output protocol error: non-JSON text frame");

  await page.evaluate(() => {
    (
      window as Window & { __mockTerminal: { releaseDelayedWrite: () => void } }
    ).__mockTerminal.releaseDelayedWrite();
  });
  await page.waitForTimeout(20);

  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __mockTerminal: { written: Array<string | Uint8Array> } }
      ).__mockTerminal.written.filter((entry) => typeof entry === "string"),
    ),
  ).toEqual([]);
});

test("snapshot replay swallows xterm protocol replies but resumes real keystrokes (#480)", async ({
  page,
}) => {
  // The remote xterm is a display mirror; the desktop pane answers protocol
  // queries. Replaying captured output makes xterm auto-answer any queries in
  // that output via onData. On reconnect the whole snapshot is replayed, so
  // every reply would otherwise flood the PTY as stray input (a phantom Enter).
  const remote = await installRemotePage(page, {
    coarse: false,
    delayFirstTerminalWrite: true,
    deferSocketCloseEvent: true,
  });
  await connect(page);

  // Hold the snapshot write mid-flight so the replay guard stays active.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __mockTerminal: { written: unknown[] } }).__mockTerminal.written
            .length,
      ),
    )
    .toBe(1);

  // xterm's reply to a query embedded in the replayed snapshot (here a DSR
  // "ESC[0n") must never reach the PTY while the replay is in flight.
  await page.evaluate(() =>
    (
      window as Window & { __mockTerminal: { emitData: (data: string) => void } }
    ).__mockTerminal.emitData("\x1b[0n"),
  );
  await page.waitForTimeout(20);
  expect(remote.writes).toHaveLength(0);

  // Once the replay completes the mirror forwards genuine keystrokes again.
  await page.evaluate(() =>
    (
      window as Window & { __mockTerminal: { releaseDelayedWrite: () => void } }
    ).__mockTerminal.releaseDelayedWrite(),
  );
  await page.waitForTimeout(20);
  await page.evaluate(() =>
    (
      window as Window & { __mockTerminal: { emitData: (data: string) => void } }
    ).__mockTerminal.emitData("ls"),
  );
  await expect.poll(() => remote.writes.length).toBe(1);
  expect(remote.writes[0]).toEqual({ leaseId: "lease-1", data: "ls" });
});

test("the mirror never answers terminal protocol queries, even in steady state (#480)", async ({
  page,
}) => {
  // The desktop pane already answers protocol queries; the mirror must answer
  // none of them. Prompt frameworks emit DSR on every render, arriving as live
  // deltas long after any replay window — so parser-level suppression, not just
  // the replay guard, has to swallow the reply.
  const remote = await installRemotePage(page, { coarse: false });
  await connect(page);

  // Steady state: no replay is in flight, yet a DSR the running program emits
  // must still produce no cursor-position reply back to the PTY.
  await page.evaluate(() =>
    (
      window as Window & {
        __mockTerminal: {
          emitCsiQueryReply: (
            id: { prefix?: string; intermediates?: string; final: string },
            reply: string,
          ) => void;
        };
      }
    ).__mockTerminal.emitCsiQueryReply({ final: "n" }, "\x1b[24;1R"),
  );
  await page.waitForTimeout(20);
  expect(remote.writes).toHaveLength(0);

  // Genuine keystrokes are untouched by the suppression.
  await page.evaluate(() =>
    (
      window as Window & { __mockTerminal: { emitData: (data: string) => void } }
    ).__mockTerminal.emitData("echo hi"),
  );
  await expect.poll(() => remote.writes.length).toBe(1);
  expect(remote.writes[0]).toEqual({ leaseId: "lease-1", data: "echo hi" });
});

test("the mirror claims every OSC color query while applying setters synchronously", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false });
  await connect(page);

  await page.evaluate(() => {
    const terminal = (
      window as Window & {
        __mockTerminal: {
          emitOscQueryReply: (ident: number, data: string, reply: string) => void;
        };
      }
    ).__mockTerminal;
    terminal.emitOscQueryReply(10, "?", "\x1b]10;rgb:f0f0/f0f0/f0f0\x1b\\");
    terminal.emitOscQueryReply(11, "?", "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\");
  });

  await page.waitForTimeout(20);
  expect(remote.writes).toHaveLength(0);
  expect(
    await page.evaluate(() => {
      const terminal = (
        window as Window & {
          __mockTerminal: {
            isOscHandled: (ident: number, data: string) => boolean;
            appliedColorSetters: Array<{ ident: number; data: string }>;
          };
        }
      ).__mockTerminal;
      return {
        indexedQuery: terminal.isOscHandled(4, "7;?"),
        indexedMixed: terminal.isOscHandled(4, "7;?;8;#abcdef"),
        indexedTrailing: terminal.isOscHandled(4, "7;?;"),
        cursorQuery: terminal.isOscHandled(12, "?"),
        cursorTrailing: terminal.isOscHandled(12, "?;"),
        foregroundSet: terminal.isOscHandled(10, "#123456"),
        indexedSet: terminal.isOscHandled(4, "7;#123456"),
        specialSetAndQuery: terminal.isOscHandled(10, "#654321;?"),
        mixedQueryAndSet: terminal.isOscHandled(10, "?;#123456"),
        appliedColorSetters: terminal.appliedColorSetters,
      };
    }),
  ).toEqual({
    indexedQuery: true,
    indexedMixed: true,
    indexedTrailing: true,
    cursorQuery: true,
    cursorTrailing: true,
    foregroundSet: false,
    indexedSet: false,
    specialSetAndQuery: true,
    mixedQueryAndSet: true,
    appliedColorSetters: [
      { ident: 4, data: "8;#abcdef" },
      { ident: 10, data: "#654321" },
      { ident: 11, data: "#123456" },
    ],
  });
});

test("an in-flight snapshot is sent once and only clears the unchanged revision", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true, holdInputs: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  const composer = page.locator("#terminalComposer");
  const send = page.locator("#composerSend");
  await editor.fill("before send");
  // Two quick sends must not double-submit. A disabled button swallows real
  // clicks, so drive the second submit through a synthetic click that still
  // reaches the handler — only the draft.inFlight gate can block it.
  await send.click();
  await send.evaluate((button) =>
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  await page.waitForTimeout(20);
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(composer).toHaveAttribute("data-can-send", "false");
  await expect(send).toBeDisabled();
  await expect(editor).toBeEnabled();

  await editor.fill("edited while pending");
  await remote.inputs[0].respond();
  await expect(composer).toHaveAttribute("data-can-send", "true");
  await expect(editor).toHaveValue("edited while pending");

  await send.click();
  await expect.poll(() => remote.inputs.length).toBe(2);
  await remote.inputs[1].respond();
  await expect(editor).toHaveValue("");

  await editor.fill("preserve on failure");
  await send.click();
  await expect.poll(() => remote.inputs.length).toBe(3);
  await remote.inputs[2].respond(500);
  await expect(editor).toHaveValue("preserve on failure");
  await expect(composer).toHaveAttribute("data-can-send", "true");

  await editor.fill("terminal one pending");
  await send.click();
  await expect.poll(() => remote.inputs.length).toBe(4);
  await selectTerminal(page, "C:\\two");
  await editor.fill("terminal two draft");
  await remote.inputs[3].respond();
  await expect(editor).toHaveValue("terminal two draft");
  await selectTerminal(page, "C:\\one");
  await expect(editor).toHaveValue("");
});

test("disconnect releases an in-flight Composer action while preserving its draft", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true, holdInputs: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  const composer = page.locator("#terminalComposer");
  await editor.fill("preserve across disconnect");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(composer).toHaveAttribute("data-can-send", "false");

  // The mobile connected layout collapses this control outside the viewport;
  // invoke the same button action without coupling this state test to drawer UX.
  await page.locator("#exit").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#connect")).toBeEnabled();
  await page.locator("#connect").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");

  await expect(editor).toHaveValue("preserve across disconnect");
  await expect(editor).toBeEnabled();
  await expect(composer).toHaveAttribute("data-can-send", "true");

  // Settle the mocked, already-aborted route so the test leaves no pending
  // Playwright handler behind. The stale response must not clear the draft.
  await remote.inputs[0].respond().catch(() => {});
  await expect(editor).toHaveValue("preserve across disconnect");
});

test("Composer keeps xterm unfocused and hides its inactive application cursor", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  // Attach leaves the focus alone on a touch device (ADR-0196), so raise the
  // editor the way a person does before asserting the composer's cursor policy.
  await page.locator("#focusTerminal").click();
  await expect(page.locator("#composerInput")).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __mockTerminal: { options: Record<string, unknown> } }).__mockTerminal
          .options.cursorInactiveStyle,
    ),
  ).toBe("none");

  await page.locator("#terminal .xterm").click();
  expect(await page.evaluate(() => document.activeElement?.className)).not.toContain(
    "xterm-helper-textarea",
  );

  await clickInputModeToggle(page);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __mockTerminal: { options: Record<string, unknown> } }).__mockTerminal
          .options.cursorInactiveStyle,
    ),
  ).toBe("outline");
  // The mode switch itself focuses the direct surface; the Keyboard button
  // toggles that focus (dismiss when focused, raise when blurred).
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ""))
    .toContain("xterm-helper-textarea");
  await page.locator("#focusTerminal").click();
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).not.toContain(
    "xterm-helper-textarea",
  );
  await page.locator("#focusTerminal").click();
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain(
    "xterm-helper-textarea",
  );
});

test("Direct-input xterm textarea opts out of browser autofill (issue #503)", async ({ page }) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  // xterm's helper textarea ships autocorrect/autocapitalize/spellcheck off
  // but omits autocomplete; without it mobile browsers offer password,
  // credit-card, and location autofill over the direct-input keyboard.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __mockTerminal?: { textarea: HTMLTextAreaElement | null };
            }
          ).__mockTerminal?.textarea?.getAttribute("autocomplete") ?? null,
      ),
    )
    .toBe("off");
});

// A soft keyboard only opens inside the gesture that asked for it, and attach
// finishes several awaits after the tap that started it. Focusing there would
// leave DOM focus without an IME — and the Keyboard button reads DOM focus as
// "the keyboard is up", so its first tap would dismiss instead of raise
// (ADR-0196).
// These specs drive a coarse pointer through the matchMedia stub and click with
// a mouse, because a headless browser has no IME to observe: they pin the state
// the IME depends on (nobody holds the focus until a gesture asks for it), not
// the keyboard itself. Real-device measurement stays the final word.
test("coarse-pointer attach leaves the input focus for the first Keyboard tap (ADR-0196)", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  const composer = page.locator("#terminalComposer");
  const editor = page.locator("#composerInput");
  const activeTagName = () => page.evaluate(() => document.activeElement?.tagName ?? "");

  await expect(composer).toBeVisible();
  await expect(editor).toBeEnabled();
  expect(await activeTagName()).toBe("BODY");
  // A focus arriving late — a microtask or timer behind the snapshot — must not
  // sneak in either, so re-check once the send affordance has settled.
  await expect(composer).toHaveAttribute("data-can-send", "true");
  expect(await activeTagName()).toBe("BODY");

  // One tap raises: the editor stays open and takes focus inside the gesture.
  await page.locator("#focusTerminal").click();
  await expect(composer).toBeVisible();
  await expect(editor).toBeFocused();
});

test.describe("mobile touch Composer focus", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the first terminal touch survives initial attach and late xterm focus", async ({
    page,
  }) => {
    const remote = await installRemotePage(page, {
      coarse: true,
      holdInitialNavigation: true,
      delayTerminal1Snapshot: true,
      lateTerminalFocusAfterTouchTap: true,
    });

    const editor = page.locator("#composerInput");
    await page.locator("#token").fill("test-token");
    await page.locator("#connect").click();
    await expect.poll(() => remote.navigations.length).toBe(1);

    // The lease exists here, but navigation has not established which terminal
    // owns the draft. An xterm created in this interval is a tappable input
    // surface with no Composer target — the original cold-entry race.
    await expect(page.locator("#terminal .xterm")).toHaveCount(0);
    await expect(editor).toBeDisabled();

    await remote.navigations[0].respond();
    await expect(page.locator("#status")).toHaveText("Main · Pane 1");
    await expect(page.locator("#terminal .xterm")).toBeVisible();
    await expect(editor).not.toBeFocused();
    await expect(editor).toBeEnabled();
    await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");

    // The output snapshot is still pending. The first real terminal tap must
    // nevertheless focus the visible editor, and keep it after xterm's helper
    // textarea tries to take focus later in the same touch turn.
    const terminalBox = await page.locator("#terminal .xterm").boundingBox();
    expect(terminalBox).not.toBeNull();
    await page.touchscreen.tap(
      terminalBox!.x + terminalBox!.width / 2,
      terminalBox!.y + terminalBox!.height / 2,
    );

    await expect(page.locator(".xterm-helper-textarea")).toHaveAttribute(
      "data-late-touch-focus",
      "true",
    );
    await expect(editor).toBeFocused();
    await page.keyboard.type("touch input works");
    await expect(editor).toHaveValue("touch input works");

    await page.evaluate(() => {
      const [socket] = (window as Window & { __mockSockets: Array<{ emitSnapshot: () => void }> })
        .__mockSockets;
      socket.emitSnapshot();
    });
    await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("touch input works");
  });

  test("reports xterm construction failure through the connect transaction", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installRemotePage(page, {
      coarse: true,
      failTerminalConstruction: true,
    });

    await page.locator("#token").fill("test-token");
    await page.locator("#connect").click();

    await expect(page.locator("#status")).toHaveText("xterm constructor failed");
    await expect(page.locator("#connect")).toBeEnabled();
    await expect(page.locator("#terminal .xterm")).toHaveCount(0);
    expect(pageErrors).not.toContain("xterm constructor failed");
  });

  test("double and triple terminal taps leave Composer unfocused for selection", async ({
    page,
  }) => {
    await installRemotePage(page, { coarse: true });
    await connect(page);

    const editor = page.locator("#composerInput");
    const terminalBox = await page.locator("#terminal .xterm").boundingBox();
    expect(terminalBox).not.toBeNull();
    const tapTerminal = () =>
      page.touchscreen.tap(
        terminalBox!.x + terminalBox!.width / 2,
        terminalBox!.y + terminalBox!.height / 2,
      );

    await tapTerminal();
    await tapTerminal();
    await expect(editor).not.toBeFocused();

    await page.waitForTimeout(600);
    await tapTerminal();
    await tapTerminal();
    await tapTerminal();
    await expect(editor).not.toBeFocused();
  });
});

test("a coarse-pointer terminal switch also leaves the focus alone (ADR-0196)", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#composerInput")).toBeFocused();

  // Selecting a pane starts an attach that finishes several awaits later, so it
  // must not hand the focus back behind the user's back either.
  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#status")).toHaveText("Main · Pane 2");
  await expect(page.locator("#composerInput")).not.toBeFocused();

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#composerInput")).toBeFocused();
});

test("coarse-pointer Direct attach also leaves the focus for the first Keyboard tap (ADR-0196)", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true, storedMode: "direct" });
  await connect(page);

  const activeClassName = () => page.evaluate(() => document.activeElement?.className ?? "");
  expect(await activeClassName()).not.toContain("xterm-helper-textarea");

  await page.locator("#focusTerminal").click();
  await expect.poll(activeClassName).toContain("xterm-helper-textarea");
});

test("fine-pointer attach keeps focusing the composer at connect (ADR-0196)", async ({ page }) => {
  await installRemotePage(page, { coarse: false, width: 1280, storedMode: "composer" });
  await connect(page);

  await expect(page.locator("#composerInput")).toBeFocused();
});

// The axis is the pointer, not the layout: the PC app's embedded mobile view is
// a mobile layout driven by a hardware keyboard, so it keeps its attach focus.
test("PC-app embedded mobile view keeps its attach focus (ADR-0196)", async ({ page }) => {
  await installRemotePage(page, { coarse: false, localApp: true, storedMode: "composer" });
  await connect(page);

  await expect(page.locator("#composerInput")).toBeFocused();
});

test("Keyboard button collapses and restores the Composer editor with the soft keyboard", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  const composer = page.locator("#terminalComposer");
  const editor = page.locator("#composerInput");
  const keyboardButton = page.locator("#focusTerminal");

  // The first tap raises the keyboard (attach left the focus alone, ADR-0196);
  // the next one dismisses it and collapses the editor pane with it.
  await expect(editor).not.toBeFocused();
  await keyboardButton.click();
  await expect(editor).toBeFocused();
  await expect(composer).toBeVisible();
  await editor.fill("draft survives collapse");

  await keyboardButton.click();
  await expect(composer).toBeHidden();
  await expect(editor).not.toBeFocused();
  // The hidden draft must not be sendable; the button stays (footer layout
  // is stable) but disabled.
  await expect(page.locator("#composerSend")).toBeVisible();
  await expect(page.locator("#composerSend")).toBeDisabled();

  // The second toggle restores the editor pane and raises the keyboard.
  await keyboardButton.click();
  await expect(composer).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("draft survives collapse");
  await expect(page.locator("#composerSend")).toBeEnabled();
});

test("reconnect keeps a collapsed Composer editor collapsed and unfocused", async ({ page }) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  // Raise, then dismiss: only a keyboard the user actually opened can collapse.
  await page.locator("#focusTerminal").click();
  await expect(page.locator("#composerInput")).toBeFocused();
  await page.locator("#focusTerminal").click();
  await expect(page.locator("#terminalComposer")).toBeHidden();

  // The mobile connected layout collapses this control outside the viewport;
  // invoke the same button action without coupling this state test to drawer UX.
  await page.locator("#exit").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#connect")).toBeEnabled();
  await page.locator("#connect").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");

  // Attach-ready auto-focus must not resurrect the editor or raise the
  // keyboard behind the user's back — only the Keyboard button does.
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await expect(page.locator("#composerInput")).not.toBeFocused();

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(page.locator("#composerInput")).toBeFocused();
});

test("explicit mode switches reset a collapsed Composer editor", async ({ page }) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#composerInput")).toBeFocused();
  await page.locator("#focusTerminal").click();
  await expect(page.locator("#terminalComposer")).toBeHidden();

  // Direct and back to Composer: the mode switch must reveal the editor
  // instead of leaving composer mode with no visible input surface.
  await clickInputModeToggle(page);
  await clickInputModeToggle(page);
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(page.locator("#composerInput")).toBeFocused();
});

test("special keys cancel the mousedown focus-theft default so the soft keyboard stays up (#482)", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true });
  await connect(page);

  // The Keyboard tap is what raises the mobile keyboard (ADR-0196); from here
  // on the editor holds focus and must keep it through every special key.
  const editor = page.locator("#composerInput");
  await page.locator("#focusTerminal").click();
  await expect(editor).toBeFocused();
  await page.locator("#keyBarToggle").click();

  // A native tap fires mousedown before the browser moves focus. WebKit/iOS
  // only honors mousedown.preventDefault() to keep the focused textarea (and
  // its open keyboard) — pointerdown preventDefault is ignored there (#482).
  // Every key that emits input — a soft key, the flick pad, and the ^C key in
  // the footer — must cancel that default so focus never leaves the editor.
  const mousedownKeys = ['[data-key="esc"]', '[data-key="dpad"]', '[data-key="c-c"]'];
  for (const selector of mousedownKeys) {
    const prevented = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(prevented, `${selector} must preventDefault on mousedown`).toBe(true);
  }

  // The original pointerdown guard stays in place for Chromium/Firefox/pen.
  const pointerPrevented = await page.locator('[data-key="esc"]').evaluate((el) => {
    const event = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      isPrimary: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(pointerPrevented).toBe(true);

  // A full trusted tap still sends the key without stealing focus.
  await page.locator('[data-key="esc"]').click();
  await expect(editor).toBeFocused();
});

// --- Composer recall: Tab history popup (#504) + autocomplete (#505) ---

async function enterComposerMode(page: Page) {
  // Desktop layout (fine pointer) defaults to Direct; switch to Composer.
  await clickInputModeToggle(page);
  await expect(page.locator("#terminalComposer")).toBeVisible();
}

async function sendComposerLine(
  page: Page,
  remote: RemoteState,
  editor: ReturnType<Page["locator"]>,
  text: string,
  expectedCount: number,
) {
  await editor.fill(text);
  await editor.press("Enter");
  await expect.poll(() => remote.inputs.length).toBe(expectedCount);
  expect(remote.inputs[expectedCount - 1].body.text).toBe(text);
  await expect(editor).toHaveValue("");
}

test("Tab on an empty draft opens the newest-first recall popup and Enter fills it (#504)", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await enterComposerMode(page);
  const editor = page.locator("#composerInput");
  const list = page.locator("#composerHistoryList");

  // Empty history: Tab must not open a popup.
  await editor.focus();
  await editor.press("Tab");
  await expect(list).toBeHidden();

  await sendComposerLine(page, remote, editor, "echo one", 1);
  await sendComposerLine(page, remote, editor, "echo two", 2);
  await sendComposerLine(page, remote, editor, "echo one", 3); // duplicate

  await editor.focus();
  await editor.press("Tab");
  await expect(list).toBeVisible();
  // Newest-first + de-duplicated: [echo one, echo two].
  await expect(list.locator('[role="option"]')).toHaveText(["echo one", "echo two"]);
  await expect(list.locator('[role="option"]').nth(0)).toHaveAttribute("aria-selected", "true");

  await editor.press("ArrowDown");
  await expect(list.locator('[role="option"]').nth(1)).toHaveAttribute("aria-selected", "true");
  await editor.press("Enter");
  await expect(list).toBeHidden();
  await expect(editor).toHaveValue("echo two");
  // Selecting from the popup fills the draft; it must not send.
  expect(remote.inputs).toHaveLength(3);
});

test("an empty-editor tap opens recall only with the keyboard up and a blank tap dismisses suggestions (#504)", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true });
  await connect(page);
  const editor = page.locator("#composerInput");
  const list = page.locator("#composerHistoryList");

  // Empty history: a tap must not open a popup.
  await editor.click();
  await expect(list).toBeHidden();

  // Mobile layout sends with the dedicated Send button (ADR-0036).
  await editor.fill("echo one");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(editor).toHaveValue("");
  await editor.fill("echo two");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(2);
  await expect(editor).toHaveValue("");

  // DOM focus is not evidence that the soft keyboard is visible. The first
  // tap only raises the keyboard, so it must not cover the editor with recall.
  await editor.click();
  await expect(editor).toBeFocused();
  await expect(list).toBeHidden();

  // Model the VisualViewport shrink arriving between pointer-down and click as
  // the first tap raises the keyboard. The decision is based on gesture-start
  // geometry, so this click still must not open recall.
  await editor.dispatchEvent("pointerdown");
  await page.setViewportSize({ width: 390, height: 500 });
  await editor.dispatchEvent("click");
  await expect(list).toBeHidden();

  // A later tap starts with the keyboard visible and may now open the same
  // newest-first popup Tab opens.
  await editor.click();
  await expect(list).toBeVisible();
  await expect(list.locator('[role="option"]')).toHaveText(["echo two", "echo one"]);

  // A blank tap in the editor dismisses the visible list without changing or
  // sending the draft.
  await editor.click();
  await expect(list).toBeHidden();
  await expect(editor).toHaveValue("");
  expect(remote.inputs).toHaveLength(2);

  // Open it again to verify the existing touch-friendly pick path.
  await editor.click();
  await expect(list).toBeVisible();

  // Entries commit on mousedown (touch-friendly): fills the draft, no send.
  await list.locator('[role="option"]').nth(1).dispatchEvent("mousedown");
  await expect(list).toBeHidden();
  await expect(editor).toHaveValue("echo one");
  expect(remote.inputs).toHaveLength(2);

  // A tap on a NON-empty draft never opens the recall popup (autocomplete
  // owns the non-empty draft, and only while typing).
  await editor.click();
  await expect(list).toBeHidden();

  // A blank tap dismisses the as-you-type list too, while preserving text.
  await editor.fill("echo");
  const autocomplete = page.locator("#composerAutocompleteList");
  await expect(autocomplete).toBeVisible();
  await editor.click();
  await expect(autocomplete).toBeHidden();
  await expect(editor).toHaveValue("echo");

  // A tap mid-IME composition never opens the popup, even on an empty draft;
  // it opens again once composition ends.
  await editor.fill("");
  await editor.dispatchEvent("compositionstart");
  await editor.click();
  await expect(list).toBeHidden();
  await editor.dispatchEvent("compositionend");
  await editor.click();
  await expect(list).toBeVisible();
});

test("VirtualKeyboard geometry is authoritative over the viewport fallback", async ({ page }) => {
  const remote = await installRemotePage(page, {
    coarse: true,
    virtualKeyboardHeight: 0,
  });
  await connect(page);
  const editor = page.locator("#composerInput");
  const list = page.locator("#composerHistoryList");

  await editor.fill("echo one");
  await page.locator("#composerSend").click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(editor).toHaveValue("");

  // A supported VirtualKeyboard API reporting zero is an explicit closed
  // signal, even while another height-only viewport change exceeds fallback
  // thresholds.
  await page.setViewportSize({ width: 390, height: 500 });
  await editor.click();
  await expect(list).toBeHidden();

  await page.evaluate(() => {
    const keyboard = (
      navigator as Navigator & {
        virtualKeyboard: { boundingRect: { height: number } };
      }
    ).virtualKeyboard;
    keyboard.boundingRect.height = 280;
  });
  await editor.click();
  await expect(list).toBeVisible();
});

test("as-you-type autocomplete suggests prefixes; plain Enter still sends, arrow+Enter picks (#505)", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await enterComposerMode(page);
  const editor = page.locator("#composerInput");
  const dropdown = page.locator("#composerAutocompleteList");

  await sendComposerLine(page, remote, editor, "echo one", 1);
  await sendComposerLine(page, remote, editor, "echo two", 2);
  await sendComposerLine(page, remote, editor, "ls", 3);

  // Prefix match, newest-first, exact-query excluded, blank draft is #504's.
  await editor.fill("ec");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.locator('[role="option"]')).toHaveText(["echo two", "echo one"]);
  // No initial highlight (activeIndex = -1): a plain Enter still SENDS the draft.
  await expect(dropdown.locator('[aria-selected="true"]')).toHaveCount(0);
  await editor.press("Enter");
  await expect.poll(() => remote.inputs.length).toBe(4);
  expect(remote.inputs[3].body.text).toBe("ec");
  await expect(editor).toHaveValue("");

  // Arrow creates a highlight; then Enter PICKS (fills) instead of sending.
  await editor.fill("ec");
  await expect(dropdown).toBeVisible();
  await editor.press("ArrowDown");
  await expect(dropdown.locator('[role="option"]').nth(0)).toHaveAttribute("aria-selected", "true");
  await editor.press("Enter");
  await expect(dropdown).toBeHidden();
  await expect(editor).toHaveValue("echo two");
  expect(remote.inputs).toHaveLength(4);

  // Tab completes to the top suggestion with no active highlight.
  await editor.fill("ec");
  await expect(dropdown).toBeVisible();
  await editor.press("Tab");
  await expect(editor).toHaveValue("echo two");
});

test("Remote autocomplete reads and toggles the host-global persistent star list", async ({
  page,
}) => {
  const remote = await installRemotePage(page, {
    coarse: false,
    width: 1280,
    starredEntries: ["echo persistent"],
  });
  await connect(page);
  await enterComposerMode(page);
  const editor = page.locator("#composerInput");
  const dropdown = page.locator("#composerAutocompleteList");

  // This suggestion came from the host endpoint, not runtime history.
  await editor.fill("ec");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.locator('[role="option"]')).toHaveText(["echo persistent"]);

  await dropdown.getByRole("button", { name: "Unstar: echo persistent" }).click();
  await expect.poll(() => remote.starredEntries).toEqual([]);
  await expect(dropdown).toBeHidden();

  await sendComposerLine(page, remote, editor, "echo runtime", 1);
  await editor.fill("ec");
  await dropdown.getByRole("button", { name: "Star: echo runtime" }).click();
  await expect.poll(() => remote.starredEntries).toEqual(["echo runtime"]);
});

test("recall history is in-memory only and never written to any persistent store", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await enterComposerMode(page);
  const editor = page.locator("#composerInput");

  const secret = "export SECRET_TOKEN=hunter2-do-not-persist";
  await sendComposerLine(page, remote, editor, secret, 1);
  await sendComposerLine(page, remote, editor, "another-private-command", 2);

  // The sent text is recallable from the runtime Map...
  await editor.focus();
  await editor.press("Tab");
  await expect(page.locator("#composerHistoryList")).toBeVisible();
  await expect(page.locator("#composerHistoryList").locator('[role="option"]')).toHaveText([
    "another-private-command",
    secret,
  ]);

  // ...but no persistent storage may contain any of the input strings.
  const dump = await page.evaluate(() => {
    const collect = (storage: Storage) => {
      const out: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key == null) continue;
        out.push(key);
        out.push(storage.getItem(key) ?? "");
      }
      return out;
    };
    return {
      local: collect(window.localStorage),
      session: collect(window.sessionStorage),
    };
  });
  const haystack = [...dump.local, ...dump.session].join(" ");
  expect(haystack).not.toContain("hunter2");
  expect(haystack).not.toContain("SECRET_TOKEN");
  expect(haystack).not.toContain("another-private-command");
  // Only the feature on/off toggles are allowed to be persisted (defaults on,
  // so they may be absent until toggled — assert none carry input text).
  expect(dump.local).not.toContain(secret);
});

test("the Remote Settings toggles disable the recall popup and autocomplete", async ({ page }) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await enterComposerMode(page);
  const editor = page.locator("#composerInput");

  await sendComposerLine(page, remote, editor, "echo one", 1);
  await sendComposerLine(page, remote, editor, "echo two", 2);

  // Open Remote Settings where the composer toggles live.
  await openRemoteSettings(page);
  await expect(page.locator("#composerHistoryPopupToggle")).toBeChecked();
  await expect(page.locator("#composerAutocompleteToggle")).toBeChecked();
  await page.locator("#composerHistoryPopupToggle").uncheck();
  await page.locator("#composerAutocompleteToggle").uncheck();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.composerHistoryPopup")))
    .toBe("0");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.composerAutocomplete")))
    .toBe("0");

  // Close the drawer, back to the editor.
  await page.locator("#navToggle").click();
  await editor.focus();

  // Tab no longer opens the recall popup...
  await editor.press("Tab");
  await expect(page.locator("#composerHistoryList")).toBeHidden();
  // ...and typing a prefix no longer shows the autocomplete dropdown.
  await editor.fill("ec");
  await expect(page.locator("#composerAutocompleteList")).toBeHidden();
});

for (const [agent, configuredLines] of [
  ["Claude", 3],
  ["Codex", 4],
  ["Grok", 2],
] as const) {
  test(`Composer subtracts its overlay from ${agent}'s configured hidden input lines`, async ({
    page,
  }) => {
    await installRemotePage(page, { coarse: false, width: 1280, activeAgent: agent });
    await connect(page);

    await enterComposerMode(page);
    const expectedDistance = await expectedComposerHiddenDistance(page, configuredLines);
    await expect.poll(() => terminalScrollDistance(page)).toBe(expectedDistance);

    await openRemoteSettings(page);
    const toggle = page.locator("#composerHideAgentInputToggle");
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute("aria-label", "Hide unused agent input");
    await expect(page.locator(`#composerHiddenAgentInputLines${agent}`)).toHaveValue(
      String(configuredLines),
    );
  });
}

test("mobile Composer describes and configures unused agent input hiding", async ({ page }) => {
  await installRemotePage(page, { coarse: true, activeAgent: "Codex" });
  await connect(page);
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
  await expect(page.locator("#terminalComposer")).toBeVisible();

  await openRemoteSettings(page);
  const toggle = page.locator("#composerHideAgentInputToggle");
  await expect(toggle).toBeChecked();
  await expect(toggle.locator("..")).toContainText("Hide unused agent input");
  await expect(toggle.locator("..")).toContainText("While using Composer");
  const claudeLines = page.locator("#composerHiddenAgentInputLinesClaude");
  await expect(claudeLines).toHaveAttribute("aria-label", "Claude input lines to hide");
  // Opening the drawer schedules terminal fits. Let those settle, then isolate
  // the inactive-agent setting change from layout-driven viewport restoration.
  await page.waitForTimeout(250);
  const distanceBeforeInactiveChange = await terminalScrollDistance(page);
  await page.evaluate(() => {
    const mock = window as typeof window & {
      __mockTerminal?: { scrollCalls: number[] };
    };
    mock.__mockTerminal?.scrollCalls.splice(0);
  });
  await claudeLines.fill("6");
  await claudeLines.blur();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const mock = window as typeof window & {
          __mockTerminal?: { scrollCalls: number[] };
        };
        return mock.__mockTerminal?.scrollCalls ?? [];
      }),
    )
    .toEqual([]);
  await expect.poll(() => terminalScrollDistance(page)).toBe(distanceBeforeInactiveChange);
  await page.evaluate(() => {
    const mock = window as typeof window & {
      __mockTerminal?: {
        scrollCalls: number[];
        setViewport: (baseY: number, viewportY: number) => void;
      };
    };
    mock.__mockTerminal?.setViewport(100, 100);
    mock.__mockTerminal?.scrollCalls.splice(0);
  });
  const codexLines = page.locator("#composerHiddenAgentInputLinesCodex");
  await codexLines.fill("6");
  await codexLines.blur();
  const expectedDistance = await expectedComposerHiddenDistance(page, 6);
  await expect.poll(() => terminalScrollDistance(page)).toBe(expectedDistance);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("laymux.remote.composerHiddenAgentInputLines")),
    )
    .toBe('{"Claude":6,"Codex":6,"Grok":2}');
});

test("leaving Composer or disabling hiding reveals the active agent input again", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true, activeAgent: "Codex" });
  await connect(page);

  await clickInputModeToggle(page);
  await expect.poll(() => terminalScrollDistance(page)).toBe(0);

  await clickInputModeToggle(page);
  const expectedHiddenDistance = await expectedComposerHiddenDistance(page, 4);
  await expect.poll(() => terminalScrollDistance(page)).toBe(expectedHiddenDistance);

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await expect.poll(() => terminalScrollDistance(page)).toBe(0);

  await page.locator("#focusTerminal").click();
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect.poll(() => terminalScrollDistance(page)).toBe(expectedHiddenDistance);

  await openRemoteSettings(page);
  await page.locator("#composerHideAgentInputToggle").uncheck();
  await expect.poll(() => terminalScrollDistance(page)).toBe(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.composerHideAgentInput")))
    .toBe("0");
});

test("Composer jump-to-bottom stops at the hidden input boundary before the live tail", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: true, activeAgent: "Codex" });
  await connect(page);
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");

  type ScrollMock = {
    buffer: { active: { baseY: number; viewportY: number } };
    scrollCalls: number[];
    setViewport: (baseY: number, viewportY: number) => void;
  };
  const readScrollState = () =>
    page.evaluate(() => {
      const mock = (
        window as typeof window & {
          __mockTerminal?: ScrollMock;
        }
      ).__mockTerminal;
      return {
        calls: mock?.scrollCalls ?? [],
        distance: mock ? mock.buffer.active.baseY - mock.buffer.active.viewportY : -1,
      };
    });

  // `connect()` reports the selected pane before snapshot replay and the
  // two-pass fit finish. Establish a settled Composer boundary before this
  // test starts simulating user-owned viewport movement.
  await expect
    .poll(async () => {
      const { calls } = await readScrollState();
      return calls.some(
        (call, index) => call === Number.POSITIVE_INFINITY && calls[index + 1] === -4,
      );
    })
    .toBe(true);
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const mock = (
      window as typeof window & {
        __mockTerminal?: ScrollMock;
      }
    ).__mockTerminal;
    document
      .querySelector("#terminal")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    mock?.scrollCalls.splice(0);
    mock?.setViewport(100, 80);
  });

  const scrollToBottom = page.locator("#scrollToBottom");
  await expect(scrollToBottom).toBeVisible();

  await scrollToBottom.click();
  await expect.poll(readScrollState).toEqual({
    calls: [Number.POSITIVE_INFINITY, -4],
    distance: 4,
  });
  await expect(scrollToBottom).toBeVisible();

  await scrollToBottom.click();
  await expect.poll(readScrollState).toEqual({
    calls: [Number.POSITIVE_INFINITY, -4, Number.POSITIVE_INFINITY],
    distance: 0,
  });
  await expect(scrollToBottom).toBeHidden();

  await page.evaluate(() => {
    const mock = (
      window as typeof window & {
        __mockTerminal?: ScrollMock;
      }
    ).__mockTerminal;
    mock?.scrollCalls.splice(0);
    const composer = document.querySelector<HTMLTextAreaElement>("#composerInput");
    composer?.blur();
    composer?.focus();
    // Keep its hide request pending behind a new fit, then move the viewport.
    // The button click below owns the final position and must cancel that hide.
    window.dispatchEvent(new Event("resize"));
    mock?.setViewport(100, 80);
    const button = document.querySelector<HTMLButtonElement>("#scrollToBottom");
    button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await expect.poll(readScrollState).toEqual({ calls: [], distance: 20 });

  await scrollToBottom.click();
  await expect.poll(readScrollState).toEqual({
    calls: [Number.POSITIVE_INFINITY, -4],
    distance: 4,
  });
  await expect(scrollToBottom).toBeVisible();
  await page.waitForTimeout(250);
  await expect.poll(readScrollState).toEqual({
    calls: [Number.POSITIVE_INFINITY, -4],
    distance: 4,
  });

  await scrollToBottom.click();
  await page.waitForTimeout(250);
  await expect.poll(readScrollState).toEqual({
    calls: [Number.POSITIVE_INFINITY, -4, Number.POSITIVE_INFINITY],
    distance: 0,
  });
  await expect(scrollToBottom).toBeHidden();
});
