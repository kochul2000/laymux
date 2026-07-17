import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const remotePagePath = new URL("../../src-tauri/src/remote_server/page.html", import.meta.url);

async function remotePageMarkup(): Promise<string> {
  const html = await readFile(remotePagePath, "utf8");
  return html
    .replace(/<script\s+src=[^>]*><\/script>/g, "")
    .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
}

type InputRequest = {
  body: { leaseId: string; text: string; submit: boolean };
  respond: (status?: number) => Promise<void>;
};

type FocusRequest = {
  terminalId: string;
  respond: () => Promise<void>;
};

type RemoteState = {
  inputs: InputRequest[];
  writes: Array<{ leaseId: string; data: string }>;
  focuses: FocusRequest[];
  claims: Array<{ clientName?: string; claimReservationId?: string }>;
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
    { id: "terminal-1", title: "Shell 1", profile: "PowerShell", cwd: "C:\\one", appearance: {} },
    { id: "terminal-2", title: "Shell 2", profile: "PowerShell", cwd: "C:\\two", appearance: {} },
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
    delayTerminal2Snapshot?: boolean;
    delayFirstTerminalWrite?: boolean;
    deferSocketCloseEvent?: boolean;
  },
) {
  await page.addInitScript(
    ({
      coarse,
      storedMode,
      legacyOutput,
      delayTerminal2Snapshot,
      delayFirstTerminalWrite,
      deferSocketCloseEvent,
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
            viewportY: 0,
            ydisp: 0,
            length: 24,
            getLine: () => null,
          },
        };
        selection = "";
        written: Array<string | Uint8Array> = [];
        private dataListener: ((data: string) => void) | null = null;
        private resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
        private delayNextWrite = Boolean(delayFirstTerminalWrite);
        private delayedWriteCallback: (() => void) | null = null;

        constructor(options: Record<string, unknown>) {
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
        onScroll(_listener: () => void) {}
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
        scrollLines(_amount: number) {}
        emitData(data: string) {
          this.dataListener?.(data);
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
            if (delayTerminal2Snapshot && url.includes("/terminals/terminal-2/output")) return;
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
    storedMode?: "direct" | "composer";
    holdInputs?: boolean;
    holdTerminalFocus?: boolean;
    legacyOutput?: boolean;
    delayTerminal2Snapshot?: boolean;
    delayFirstTerminalWrite?: boolean;
    deferSocketCloseEvent?: boolean;
    claimBusyResponses?: number;
    claimRetryAfterMs?: number;
    claimReservationTtlMs?: number;
    width?: number;
  },
): Promise<RemoteState> {
  const state: RemoteState = { inputs: [], writes: [], focuses: [], claims: [] };
  let remainingClaimBusyResponses = options.claimBusyResponses ?? 0;
  await page.setViewportSize({ width: options.width ?? 390, height: 844 });
  await installBrowserMocks(page, options);
  await page.route("http://remote.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>remote test</title>" }),
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
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigation });
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

  await page.goto("http://remote.test/");
  await page.setContent(await remotePageMarkup());
  return state;
}

async function connect(page: Page) {
  await page.locator("#token").fill("test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Connected to terminal-1");
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

test("fine-pointer PC and coarse-pointer mobile can both toggle and persist the preferred mode", async ({
  page,
}) => {
  await installRemotePage(page, { coarse: false, width: 1280 });

  const composer = page.locator("#terminalComposer");
  const toggle = page.locator("#inputModeToggle");
  await expect(composer).toBeHidden();
  await expect(toggle).toHaveText("Direct");
  await toggle.click();
  await expect(composer).toBeVisible();
  await expect(toggle).toHaveText("Composer");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.inputMode")))
    .toBe("composer");

  const geometry = await page.locator(".terminal-shell").evaluate((shell) => {
    const terminal = shell.querySelector<HTMLElement>("#terminal")!.getBoundingClientRect();
    const editor = shell.querySelector<HTMLElement>("#terminalComposer")!.getBoundingClientRect();
    return { terminalBottom: terminal.bottom, editorTop: editor.top };
  });
  expect(geometry.terminalBottom).toBeLessThanOrEqual(geometry.editorTop);

  // Re-running the static entry simulates a reload: preference survives, drafts do not.
  await page.setContent(await remotePageMarkup());
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(page.locator("#inputModeToggle")).toHaveText("Composer");
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
  await expect(page.locator("#status")).toHaveText("Connected to terminal-1");
});

test("coarse pointer defaults to Composer and a saved Direct preference wins", async ({ page }) => {
  await installRemotePage(page, { coarse: true, storedMode: "direct" });
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await expect(page.locator("#inputModeToggle")).toHaveText("Direct");

  await page.locator("#inputModeToggle").click();
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
  await page.locator("#inputModeToggle").click();
  await expect(page.locator("#terminalComposer")).toBeHidden();

  await selectTerminal(page, "C:\\one");
  await expect(page.locator("#terminalComposer")).toBeVisible();
  await expect(editor).toHaveValue("draft one");

  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#terminalComposer")).toBeHidden();
  await page.locator("#inputModeToggle").click();
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
  await expect(page.locator("#composerSend")).toBeEnabled();

  await selectTerminal(page, "C:\\two");
  await expect(page.locator("#terminalMeta")).toContainText("Shell 2");
  await expect.poll(() => remote.focuses.length).toBe(1);
  expect(remote.focuses[0].terminalId).toBe("terminal-2");

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
  await expect(page.locator("#composerSend")).toBeDisabled();

  await remote.focuses[0].respond();
  await expect(page.locator("#composerSend")).toBeDisabled();
  await page.evaluate(() => {
    const sockets = (
      window as Window & {
        __mockSockets: Array<{ emitSnapshot: () => void }>;
      }
    ).__mockSockets;
    sockets[1].emitSnapshot();
  });
  await expect(page.locator("#composerSend")).toBeEnabled();
});

test("fine-pointer Composer sends on Enter and keeps Shift+Enter as a newline", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: false, width: 1280 });
  await connect(page);
  await page.locator("#inputModeToggle").click();

  const editor = page.locator("#composerInput");
  await expect(page.locator("#composerSend")).toBeEnabled();
  await expect(page.locator("#composerInsert")).toHaveCount(0);

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

test("coarse-pointer Composer keeps Enter as a newline and sends only from its button", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  await expect(page.locator("#composerSend")).toBeEnabled();
  await expect(page.locator("#composerInsert")).toHaveCount(0);
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
  await page.locator("#ctrlC").click();
  await expect.poll(() => remote.writes.length).toBe(1);
  expect(remote.writes[0]).toEqual({ leaseId: "lease-1", data: "\x03" });
  await expect(editor).toHaveValue("untouched draft");

  await page.locator("#keyBarToggle").click();
  await page.locator('[data-key="esc"]').click();
  await expect.poll(() => remote.writes.length).toBe(2);
  expect(remote.writes[1].data).toBe("\x1b");
  await expect(editor).toHaveValue("untouched draft");
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
  await expect(page.locator("#composerSend")).toBeDisabled();
  await page.locator("#inputModeToggle").click();
  await dispatchTerminalPaste(page, "must not send");
  expect(remote.inputs).toHaveLength(0);
  await expect(page.locator("#status")).toHaveText("Terminal input is not ready. Reconnecting...");
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
  await expect(page.locator("#composerSend")).toBeDisabled();

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

  await expect(page.locator("#composerSend")).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __mockTerminal: { written: Array<string | Uint8Array> } }
      ).__mockTerminal.written.filter((entry) => typeof entry === "string"),
    ),
  ).toEqual([]);
});

test("an in-flight snapshot is sent once and only clears the unchanged revision", async ({
  page,
}) => {
  const remote = await installRemotePage(page, { coarse: true, holdInputs: true });
  await connect(page);

  const editor = page.locator("#composerInput");
  const send = page.locator("#composerSend");
  await editor.fill("before send");
  await send.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(send).toBeDisabled();
  await expect(page.locator("#composerInsert")).toHaveCount(0);
  await expect(editor).toBeEnabled();

  await editor.fill("edited while pending");
  await remote.inputs[0].respond();
  await expect(send).toBeEnabled();
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
  await expect(send).toBeEnabled();

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
  const send = page.locator("#composerSend");
  await editor.fill("preserve across disconnect");
  await send.click();
  await expect.poll(() => remote.inputs.length).toBe(1);
  await expect(send).toBeDisabled();

  // The mobile connected layout collapses this control outside the viewport;
  // invoke the same button action without coupling this state test to drawer UX.
  await page.locator("#release").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#connect")).toBeEnabled();
  await page.locator("#connect").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("#status")).toHaveText("Connected to terminal-1");

  await expect(editor).toHaveValue("preserve across disconnect");
  await expect(editor).toBeEnabled();
  await expect(send).toBeEnabled();

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

  await page.locator("#inputModeToggle").click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __mockTerminal: { options: Record<string, unknown> } }).__mockTerminal
          .options.cursorInactiveStyle,
    ),
  ).toBe("outline");
  await page.locator("#focusTerminal").click();
  expect(await page.evaluate(() => document.activeElement?.className)).toContain(
    "xterm-helper-textarea",
  );
});
