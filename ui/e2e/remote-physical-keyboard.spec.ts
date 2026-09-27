import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installRemoteClientRoutes, remoteClientMarkupWithoutXterm } from "./remote-client-assets";

const schema = JSON.parse(
  readFileSync(new URL("../src/remote/remote-settings-schema.json", import.meta.url), "utf8"),
);

type KeyboardWindow = typeof window & {
  __keyboardConnected: boolean;
  LaymuxNative?: { isPhysicalKeyboardConnected?: () => boolean; requestRemoteHttp: () => void };
  LaymuxOutputTransport?: { postMessage: () => void };
  laymuxPhysicalKeyboard?: { onChanged: (connected: boolean) => void };
};

async function openControls(
  page: Page,
  { android = true, connected = false, supported = true } = {},
) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://remote.test/**", (route) => route.fulfill({ body: "<!doctype html>" }));
  await page.addInitScript(
    ({ android, connected, supported, zones }) => {
      if (window.top !== window) return;
      const target = window as KeyboardWindow;
      if (android) {
        target.__keyboardConnected = connected;
        target.LaymuxNative = {
          requestRemoteHttp() {},
          ...(supported ? { isPhysicalKeyboardConnected: () => target.__keyboardConnected } : {}),
        };
        target.LaymuxOutputTransport = { postMessage() {} };
      }
      if (!localStorage.getItem("laymux.remote.keybar")) {
        localStorage.setItem(
          "laymux.remote.keybar",
          JSON.stringify({
            zones,
            expanded: true,
            userKeys: [],
            floating: { enabled: true, pads: { dpad: { enabled: true } }, buttons: [] },
          }),
        );
      }
    },
    { android, connected, supported, zones: schema.properties.inputBarZones.default },
  );
  await page.goto(`http://remote.test/${android ? "?androidE2e=1" : ""}`);
  await page.setContent(remoteClientMarkupWithoutXterm());
}

async function keyboardConnection(page: Page, connected: boolean) {
  await page.evaluate((next) => {
    const target = window as KeyboardWindow;
    target.__keyboardConnected = next;
    target.laymuxPhysicalKeyboard?.onChanged(next);
  }, connected);
}

async function settings(page: Page, tab = "Input bar") {
  if ((await page.locator("#navToggle").getAttribute("aria-expanded")) !== "true") {
    await page.locator("#navToggle").click();
  }
  if (await page.locator("#drawerSettingsView").isHidden()) {
    await page.locator("#drawerSettingsButton").click();
  }
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

const keybar = (page: Page) => page.evaluate(() => localStorage.getItem("laymux.remote.keybar"));
const floatingPad = (page: Page) => page.locator('#floatingControls [data-key="dpad"]');

test("연결·분리가 플로팅과 Keys 표시만 바꾸고 원래 설정을 보존한다", async ({ page }, info) => {
  await openControls(page);
  await page.locator("#navToggle").click();
  await expect(floatingPad(page)).toBeVisible();
  await expect(page.locator("#keyBar")).toBeVisible();
  const original = await keybar(page);
  await page.screenshot({ path: info.outputPath("keyboard-disconnected.png") });
  await keyboardConnection(page, true);
  await expect(floatingPad(page)).toHaveCount(0);
  await expect(page.locator("#keyBar")).toBeHidden();
  await expect(page.locator("#keyBarToggle")).toBeHidden();
  expect(await keybar(page)).toBe(original);
  await page.screenshot({ path: info.outputPath("keyboard-connected.png") });
  await keyboardConnection(page, false);
  await expect(floatingPad(page)).toBeVisible();
  await expect(page.locator("#keyBar")).toBeVisible();
  await expect(page.locator("#keyBarToggle")).toBeVisible();
  expect(await keybar(page)).toBe(original);
});

test("연결된 상태로 시작해도 두 숨김 옵션을 독립적으로 변경하고 저장한다", async ({
  page,
}, info) => {
  await openControls(page, { connected: true });
  await expect(floatingPad(page)).toHaveCount(0);
  await expect(page.locator("#keyBar")).toBeHidden();
  await settings(page, "Floating");
  await page.getByLabel("Hide floating controls with physical keyboard", { exact: true }).uncheck();
  await expect(floatingPad(page)).toBeVisible();
  await expect(page.locator("#keyBar")).toBeHidden();
  await page.getByLabel("Hide floating controls with physical keyboard", { exact: true }).check();
  await settings(page);
  await page.getByLabel("Hide Keys with physical keyboard", { exact: true }).uncheck();
  await expect(page.locator("#keyBar")).toBeVisible();
  await expect(floatingPad(page)).toHaveCount(0);
  await expect(page.getByLabel("Use Remote Nav shortcuts", { exact: true })).toBeChecked();
  await page.screenshot({ path: info.outputPath("keyboard-settings.png") });
  await page.reload();
  await page.setContent(remoteClientMarkupWithoutXterm());
  await expect(page.locator("#keyBar")).toBeVisible();
  await expect(floatingPad(page)).toHaveCount(0);
});

test("구형 Android bridge와 일반 브라우저는 키 입력 후에도 자동 숨김하지 않는다", async ({
  page,
}) => {
  for (const android of [true, false]) {
    await openControls(page, { android, supported: false });
    await page.locator("#navToggle").click();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(floatingPad(page)).toBeVisible();
    await expect(page.locator("#keyBar")).toBeVisible();
    await settings(page);
    await expect(page.locator("#physicalKeyboardStatus")).toContainText(
      "requires the updated Android app",
    );
  }
});

test("백그라운드 사이의 분리는 복귀 snapshot으로 복구한다", async ({ page }) => {
  await openControls(page, { connected: true });
  await expect(page.locator("#keyBar")).toBeHidden();
  await page.evaluate(() => {
    (window as KeyboardWindow).__keyboardConnected = false;
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.locator("#keyBar")).toBeVisible();
  await expect(floatingPad(page)).toBeVisible();
});

async function connectKeyboardRemote(page: Page, inputMode = "direct") {
  const nav: Array<{ kind: string; direction: string }> = [];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installRemoteClientRoutes(page);
  await page.addInitScript((mode) => {
    if (window.top === window) localStorage.setItem("laymux.remote.inputMode", mode);
  }, inputMode);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session/claim") || path.endsWith("/session/heartbeat")) {
      await route.fulfill({
        json: { active: true, leaseId: "lease-1", heartbeatTimeoutSeconds: 45 },
      });
    } else if (path === "/remote/v1/navigation") {
      const pane = {
        id: "pane-1",
        terminalId: "terminal-1",
        title: "Shell",
        location: "workspace",
        workspaceId: "ws-1",
        paneNumber: 1,
        paneIndex: 0,
        viewType: "terminal",
        terminalLive: true,
        isFocused: true,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        profile: "PowerShell",
        cwd: "C:\\work",
        unreadCount: 0,
        activity: { type: "shell" },
      };
      await route.fulfill({
        json: {
          activeWorkspace: { id: "ws-1", name: "Main", panes: [pane] },
          workspaces: [],
          docks: [],
          notifications: [],
          unreadNotificationCount: 0,
          terminals: [
            {
              id: "terminal-1",
              workspaceId: "ws-1",
              paneNumber: 1,
              title: "Shell",
              appearance: {},
            },
          ],
          workspaceSelector: { display: {}, pathEllipsis: "start" },
        },
      });
    } else if (path.startsWith("/remote/v1/navigation/")) {
      nav.push({
        kind: path.split("/").pop()!,
        direction: route.request().postDataJSON().direction,
      });
      await route.fulfill({ json: { moved: false, reason: "no_other_target" } });
    } else if (path.endsWith("/write")) {
      writes.push(route.request().postDataJSON().data);
      await route.fulfill({ json: {} });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const output = Buffer.from("ready\r\n");
    socket.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "snapshot",
        seqStart: 0,
        seqEnd: output.length,
        byteLength: output.length,
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: output.length,
          sourceStartSeq: 0,
          sourceSeq: output.length,
          snapshotKind: "raw",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols: 80, rows: 24 },
        },
      }),
    );
    socket.send(output);
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Shell");
  const input = page.locator(inputMode === "direct" ? ".xterm-helper-textarea" : "#composerInput");
  await input.focus();
  return { nav, writes, errors, input };
}

test("브라우저의 실제 xterm 입력에서 기본 Nav와 PC 조합을 소비하고 일반 입력을 보존한다", async ({
  page,
}) => {
  const state = await connectKeyboardRemote(page);
  for (const [key, kind, direction] of [
    ["ArrowUp", "spatial", "prev"],
    ["ArrowDown", "spatial", "next"],
    ["ArrowLeft", "notification", "recent"],
    ["ArrowRight", "notification", "oldest"],
  ]) {
    await page.keyboard.press(`Alt+${key}`);
    await expect.poll(() => state.nav.at(-1)).toEqual({ kind, direction });
  }
  await page.keyboard.press("Control+Alt+ArrowDown");
  await page.keyboard.type("a");
  await expect.poll(() => state.writes.join("")).toBe("a");
  expect(state.nav).toHaveLength(4);
  expect(state.errors).toEqual([]);
});

test("Nav 보조키 변경·해제는 즉시 적용되고 설정 입력은 가로채지 않는다", async ({ page }) => {
  const state = await connectKeyboardRemote(page);
  await settings(page);
  await page.getByLabel("Nav shortcut", { exact: true }).selectOption("ctrlAlt");
  await page.getByLabel("Use Remote Nav shortcuts", { exact: true }).focus();
  await page.keyboard.press("Control+Alt+ArrowUp");
  await page.locator("#navToggle").click();
  await state.input.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Control+Alt+ArrowDown");
  await expect.poll(() => state.nav).toEqual([{ kind: "spatial", direction: "next" }]);
  await page.keyboard.type("a");
  await expect.poll(() => state.writes.join("")).toBe("a");
  await settings(page);
  await page.getByLabel("Use Remote Nav shortcuts", { exact: true }).uncheck();
  await expect(page.getByLabel("Nav shortcut", { exact: true })).toBeDisabled();
  await page.locator("#navToggle").click();
  await state.input.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => state.nav.at(-1)).toEqual({ kind: "direction", direction: "down" });
  expect(state.nav).toHaveLength(2);
  expect(state.writes.join("")).toBe("a");
  expect(state.errors).toEqual([]);
});

test("기본 Nav를 켜도 메뉴 단축키로 열고 닫으며 메뉴 안에서는 Nav를 실행하지 않는다", async ({
  page,
}) => {
  const state = await connectKeyboardRemote(page);
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "false");
  expect(state.nav).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Composer 초안을 보존하며 반복 키·IME 조합은 추가 탐색을 만들지 않는다", async ({ page }) => {
  const state = await connectKeyboardRemote(page, "composer");
  await state.input.fill("보존할 초안");
  await page.keyboard.down("Alt");
  await page.keyboard.down("ArrowDown");
  await expect.poll(() => state.nav.length).toBe(1);
  await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowDown");
  await page.keyboard.up("Alt");
  await state.input.dispatchEvent("keydown", { key: "ArrowUp", altKey: true, isComposing: true });
  await expect(state.input).toHaveText("보존할 초안");
  expect(state.nav).toHaveLength(1);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
