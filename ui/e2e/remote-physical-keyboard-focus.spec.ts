import { expect, test, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

type FocusWindow = typeof window & {
  LaymuxNative: {
    isPhysicalKeyboardConnected: () => boolean;
    requestRemoteHttp: (id: string, method: string, path: string, body: string | null) => void;
    cancelRemoteHttp: () => void;
    setRemoteLease: () => void;
  };
  LaymuxOutputTransport: {
    onmessage?: (event: { data: ArrayBuffer }) => void;
    postMessage: (raw: string) => void;
  };
  laymuxAndroidE2e?: { onHttpResponse: (id: string, response: string) => void };
  laymuxPhysicalKeyboard?: { onChanged: (connected: boolean) => void };
  __keyboardConnected: boolean;
  __writes: Array<{ terminalId: string; data: string }>;
  __holdOutput: boolean;
  __pendingOutput?: () => void;
};

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

async function openRemote(page: Page, mode: "direct" | "composer", connected = true) {
  await page.route("http://remote.test/remote/**", async (route) => {
    if (!(await fulfillRemoteClientAsset(route, new URL(route.request().url()).pathname))) {
      await route.fulfill({ json: {} });
    }
  });
  await page.addInitScript(
    ({ mode, connected }) => {
      const target = window as FocusWindow;
      target.__keyboardConnected = connected;
      target.__writes = [];
      localStorage.setItem("laymux.remote.inputMode", mode);
      const panes = [1, 2].map((number) => ({
        id: `pane-${number}`,
        terminalId: `terminal-${number}`,
        title: `Shell ${number}`,
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: number - 1,
        paneNumber: number,
        viewType: "terminal",
        terminalLive: true,
        isFocused: number === 1,
        hidden: false,
        collapsed: false,
        x: 0,
        y: (number - 1) / 2,
        w: 1,
        h: 0.5,
        profile: "Shell",
        cwd: "/work",
        unreadCount: 0,
        activity: { type: "shell" },
      }));
      const navigation = {
        activeWorkspace: { id: "ws-1", name: "Main", focusedPaneNumber: 1, panes },
        workspaces: [
          {
            id: "ws-1",
            name: "Main",
            isActive: true,
            panes,
            paneCount: 2,
            terminalPaneCount: 2,
            liveTerminalCount: 2,
          },
        ],
        docks: [],
        notifications: [],
        unreadNotificationCount: 0,
        terminals: panes.map((pane) => ({ ...pane, id: pane.terminalId, appearance: {} })),
        workspaceSelector: { display: {}, pathEllipsis: "start" },
      };
      target.LaymuxNative = {
        isPhysicalKeyboardConnected: () => target.__keyboardConnected,
        requestRemoteHttp(id, _method, path, rawBody) {
          let body: unknown = {};
          if (path.endsWith("/session/claim") || path.endsWith("/session/heartbeat")) {
            body = {
              active: true,
              leaseId: "lease-1",
              fileViewerToken: "viewer-1",
              heartbeatTimeoutSeconds: 45,
            };
          } else if (path === "/remote/v1/navigation") body = navigation;
          else if (path.endsWith("/write")) {
            target.__writes.push({
              terminalId: path.split("/")[4],
              data: JSON.parse(rawBody!).data,
            });
          }
          setTimeout(
            () =>
              target.laymuxAndroidE2e?.onHttpResponse(
                id,
                JSON.stringify({ kind: "http", status: 200, body }),
              ),
            0,
          );
        },
        cancelRemoteHttp() {},
        setRemoteLease() {},
      };
      target.LaymuxOutputTransport = {
        postMessage(raw) {
          const message = JSON.parse(raw);
          if (message.type !== "open") return;
          const emit = (kind: number, bytes = new Uint8Array()) => {
            const stream = new TextEncoder().encode(message.streamId);
            const frame = new Uint8Array(3 + stream.length + bytes.length);
            frame[0] = kind;
            new DataView(frame.buffer).setUint16(1, stream.length, false);
            frame.set(stream, 3);
            frame.set(bytes, 3 + stream.length);
            target.LaymuxOutputTransport.onmessage?.({ data: frame.buffer });
          };
          const deliver = () => {
            emit(1);
            const bytes = new TextEncoder().encode("ready\r\n");
            const header = new TextEncoder().encode(
              JSON.stringify({
                type: "terminal.output",
                version: 1,
                phase: "snapshot",
                seqStart: 0,
                seqEnd: bytes.length,
                byteLength: bytes.length,
                state: {
                  version: 1,
                  generation: 1,
                  snapshotStartSeq: 0,
                  snapshotSeq: bytes.length,
                  sourceStartSeq: 0,
                  sourceSeq: bytes.length,
                  snapshotKind: "raw",
                  protocolRevision: 0,
                  modes: { bracketedPaste: false },
                  geometry: { revision: 0, cols: 80, rows: 24 },
                },
              }),
            );
            emit(2, new Uint8Array([2, ...header]));
            emit(2, new Uint8Array([3, ...bytes]));
          };
          if (target.__holdOutput) target.__pendingOutput = deliver;
          else setTimeout(deliver, 0);
        },
      };
    },
    { mode, connected },
  );
  await page.goto("http://remote.test/remote/?androidE2e=1#token=test");
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toContainText("Pane 1");
  await expect(page.locator(".xterm-rows")).toContainText("ready");
  return page.locator(mode === "direct" ? ".xterm-helper-textarea" : "#composerInput");
}

async function selectSecondPane(page: Page, waitForOutput = true) {
  await page.locator("#navToggle").click();
  await page.locator('[data-pane-row="pane-2"]').tap();
  if (waitForOutput) await expect(page.locator("#status")).toContainText("Pane 2");
}

for (const mode of ["direct", "composer"] as const) {
  test(`${mode}: 물리 키보드 연결 중 터치 pane 전환은 입력에 포커스를 돌린다`, async ({
    page,
  }, info) => {
    const input = await openRemote(page, mode);
    await selectSecondPane(page);
    await expect(input).toBeFocused();
    await page.screenshot({ path: info.outputPath(`${mode}-pane-focus.png`) });
    await page.keyboard.type("tap");
    if (mode === "composer") await expect(input).toHaveText("tap");
    else
      await expect
        .poll(() =>
          page.evaluate(() => ({
            targets: [
              ...new Set((window as FocusWindow).__writes.map((write) => write.terminalId)),
            ],
            text: (window as FocusWindow).__writes.map((write) => write.data).join(""),
          })),
        )
        .toEqual({ targets: ["terminal-2"], text: "tap" });
  });

  test(`${mode}: 잃어버린 포커스를 일반 입력으로 복구하고 첫 글자를 한 번만 전달한다`, async ({
    page,
  }) => {
    const input = await openRemote(page, mode);
    await input.focus();
    await input.evaluate((element) => (element as HTMLElement).blur());
    await page.keyboard.type("Ab1");
    await expect(input).toBeFocused();
    if (mode === "composer") await expect(input).toHaveText("Ab1");
    else
      await expect
        .poll(() =>
          page.evaluate(() => (window as FocusWindow).__writes.map((write) => write.data).join("")),
        )
        .toBe("Ab1");
  });

  test(`${mode}: attach를 기다리며 연 모달에는 뒤늦게 포커스를 빼앗지 않는다`, async ({ page }) => {
    const input = await openRemote(page, mode);
    await page.evaluate(() => {
      (window as FocusWindow).__holdOutput = true;
    });
    await selectSecondPane(page, false);
    await expect
      .poll(() => page.evaluate(() => Boolean((window as FocusWindow).__pendingOutput)))
      .toBe(true);
    await page.locator("#oauthRelayScrim").evaluate((element) => {
      (element as HTMLElement).hidden = false;
    });
    await input.evaluate((element) => (element as HTMLElement).blur());
    await page.evaluate(() => (window as FocusWindow).__pendingOutput?.());
    await expect(page.locator("#terminalComposer")).toHaveAttribute(
      "data-can-send",
      mode === "composer" ? "true" : "false",
    );
    await expect(input).not.toBeFocused();
    await page.keyboard.type("a");
    await expect(input).not.toBeFocused();
  });

  test(`${mode}: 제어 키와 진행 중인 조합은 포커스 복구를 시작하지 않는다`, async ({ page }) => {
    const input = await openRemote(page, mode);
    await input.evaluate((element) => (element as HTMLElement).blur());
    for (const key of ["Shift", "Control", "Alt", "ArrowLeft", "Escape", "Control+c"]) {
      await page.keyboard.press(key);
      await expect(input).not.toBeFocused();
    }
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", isComposing: true, bubbles: true }),
      ),
    );
    await expect(input).not.toBeFocused();
  });

  test(`${mode}: 분리 상태와 다른 입력칸 및 오버레이의 입력은 가져오지 않는다`, async ({
    page,
  }) => {
    const input = await openRemote(page, mode, false);
    await selectSecondPane(page);
    await expect(input).not.toBeFocused();
    await page.keyboard.type("a");
    await expect(input).not.toBeFocused();
    await page.evaluate(() => {
      const target = window as FocusWindow;
      target.__keyboardConnected = true;
      target.laymuxPhysicalKeyboard?.onChanged(true);
    });
    for (const id of [
      "oauthRelayScrim",
      "composerStarEditorScrim",
      "fileViewerOverlay",
      "githubOverlay",
      "memoOverlay",
    ]) {
      const overlay = page.locator(`#${id}`);
      await overlay.evaluate((element) => {
        (element as HTMLElement).hidden = false;
      });
      await page.keyboard.type("a");
      await expect(input).not.toBeFocused();
      await overlay.evaluate((element) => {
        (element as HTMLElement).hidden = true;
      });
    }
    await page.locator("#navToggle").click();
    await page.keyboard.type("a");
    await expect(input).not.toBeFocused();
    await page.locator("#navToggle").click();
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.id = "otherInput";
      document.body.append(field);
      field.focus();
    });
    await page.keyboard.type("elsewhere");
    await expect(page.locator("#otherInput")).toHaveValue("elsewhere");
    await expect(input).not.toBeFocused();
  });
}
