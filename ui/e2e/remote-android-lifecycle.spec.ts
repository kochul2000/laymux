import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { fulfillRemoteClientAsset } from "./remote-client-assets";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

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
  workspaces: [],
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
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

type AndroidLifecycleState = {
  cancelledRequests: number;
  claimRequests: number;
  heartbeatRequests: number;
  fileViewerRequests: Array<{ method: string; path: string; body: unknown }>;
  heldRequestId: string | null;
  heldOauthBeginRequestId: string | null;
  heldOauthForwardRequestId: string | null;
  holdNextClaim: boolean;
  holdNextNavigation: boolean;
  holdNextOauthBegin: boolean;
  holdNextOauthForward: boolean;
  navigationRequests: number;
  nativeOauthBegins: Array<{
    authUrl: string;
    path: string;
    port: string;
    sessionId: string;
  }>;
  nativeOauthCancels: number;
  oauthBeginRequests: number;
  oauthForwardRequests: Array<{ leaseId: string; sessionId: string; pathAndQuery: string }>;
  outputOpens: number;
  renderRequests: number;
  savedFiles: Array<{ name: string; mediaType: string; base64: string }>;
  openedFiles: Array<{ name: string; mediaType: string; base64: string }>;
  leases: Array<string | null>;
  releaseRequests: Array<{ leaseId: string }>;
  heldReleaseRequestId: string | null;
  disconnects: number;
  attachments: Array<{ leaseId: string; fileName: string; data: string }>;
  canceledShares: string[];
};

type AndroidLifecycleWindow = typeof window & {
  LaymuxNative: {
    requestRemoteHttp: (
      requestId: string,
      method: string,
      path: string,
      bodyJson: string | null,
    ) => void;
    cancelRemoteHttp: (requestId: string) => void;
    setRemoteLease: (leaseId: string | null) => void;
    saveRemoteFile: (name: string, mediaType: string, base64: string) => void;
    openRemoteFile?: (name: string, mediaType: string, base64: string) => void;
    disconnectRemote: () => void;
    beginOauthRelay: (sessionId: string, port: string, path: string, authUrl: string) => void;
    cancelOauthRelay: () => void;
    cancelSharedFiles: (id: string) => void;
  };
  __activateRemoteUrl?: (uri: string) => void;
  LaymuxOutputTransport: {
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    postMessage: (message: string) => void;
  };
  laymuxAndroidE2e?: {
    onHttpResponse: (requestId: string, responseJson: string) => void;
    onNativeForeground?: () => boolean;
    onNativeBackground?: () => boolean;
  };
  laymuxRemoteUi?: {
    dismissTopLayer: () => boolean;
    offerSharedFiles: (offer: { id: string; count: number }) => boolean;
    takeSharedFileSelection: () => string | null;
  };
  laymuxOauthRelay?: {
    onCallback: (pathAndQuery: string) => void;
    onError: (message: string) => void;
  };
  __androidLifecycleState: AndroidLifecycleState;
  __remoteDocumentSentinel?: object;
};

function dismissTopRemoteLayer(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as AndroidLifecycleWindow).laymuxRemoteUi?.dismissTopLayer() ?? false,
  );
}

async function installAndroidRemote(
  page: Page,
  options: { holdInitialClaim?: boolean; otherTerminal?: boolean } = {},
) {
  const fixture = structuredClone(navigation);
  if (options.otherTerminal) {
    const first = { ...fixture.activeWorkspace.panes[0], viewType: "TerminalView" };
    const second = {
      ...first,
      id: "pane-2",
      terminalId: "terminal-2",
      paneNumber: 2,
      title: "Other shell",
      isFocused: false,
      x: 1,
    };
    fixture.activeWorkspace.panes = [first, second];
    Object.assign(fixture, {
      workspaces: [
        { ...fixture.activeWorkspace, isActive: true, hidden: false, terminalPaneCount: 2 },
      ],
    });
    fixture.terminals.push({
      ...fixture.terminals[0],
      id: "terminal-2",
      title: "Other shell",
      paneNumber: 2,
    });
  }
  await page.addInitScript(
    ({ remoteNavigation, holdInitialClaim }) => {
      localStorage.setItem("laymux.remote.inputMode", "composer");

      const target = window as AndroidLifecycleWindow;
      type TerminalOptions = {
        linkHandler?: {
          activate?: (event: MouseEvent, uri: string) => void;
        };
      };
      type TerminalConstructor = new (options?: TerminalOptions) => object;
      Object.defineProperty(target, "Terminal", {
        configurable: true,
        set(value: TerminalConstructor) {
          class CapturingTerminal extends value {
            constructor(options?: TerminalOptions) {
              const activate = options?.linkHandler?.activate;
              if (activate) {
                target.__activateRemoteUrl = (uri) => activate(new MouseEvent("click"), uri);
              }
              super(options);
            }
          }
          Object.defineProperty(target, "Terminal", {
            configurable: true,
            value: CapturingTerminal,
            writable: true,
          });
        },
      });
      const state: AndroidLifecycleState = {
        cancelledRequests: 0,
        claimRequests: 0,
        heartbeatRequests: 0,
        fileViewerRequests: [],
        heldRequestId: null,
        heldOauthBeginRequestId: null,
        heldOauthForwardRequestId: null,
        holdNextClaim: holdInitialClaim,
        holdNextNavigation: false,
        holdNextOauthBegin: false,
        holdNextOauthForward: false,
        navigationRequests: 0,
        nativeOauthBegins: [],
        nativeOauthCancels: 0,
        oauthBeginRequests: 0,
        oauthForwardRequests: [],
        outputOpens: 0,
        renderRequests: 0,
        savedFiles: [],
        openedFiles: [],
        leases: [],
        releaseRequests: [],
        heldReleaseRequestId: null,
        disconnects: 0,
        attachments: [],
        canceledShares: [],
      };
      target.__androidLifecycleState = state;

      const emitOutputEvent = (streamId: string, event: number, payload = new Uint8Array()) => {
        const streamBytes = new TextEncoder().encode(streamId);
        const message = new Uint8Array(3 + streamBytes.byteLength + payload.byteLength);
        message[0] = event;
        new DataView(message.buffer).setUint16(1, streamBytes.byteLength, false);
        message.set(streamBytes, 3);
        message.set(payload, 3 + streamBytes.byteLength);
        target.LaymuxOutputTransport.onmessage?.({ data: message.buffer });
      };

      const emitOutputRecord = (streamId: string, kind: number, payload: Uint8Array) => {
        const record = new Uint8Array(1 + payload.byteLength);
        record[0] = kind;
        record.set(payload, 1);
        emitOutputEvent(streamId, 2, record);
      };

      target.LaymuxOutputTransport = {
        onmessage: null,
        postMessage(raw) {
          const message = JSON.parse(raw) as { type: string; streamId: string };
          if (message.type !== "open") return;
          state.outputOpens += 1;
          const generation = state.outputOpens;
          setTimeout(() => {
            emitOutputEvent(message.streamId, 1);
            const output = new TextEncoder().encode(`generation-${generation}\r\n`);
            const header = new TextEncoder().encode(
              JSON.stringify({
                type: "terminal.output",
                version: 1,
                phase: "snapshot",
                seqStart: 0,
                seqEnd: output.byteLength,
                byteLength: output.byteLength,
                state: {
                  version: 1,
                  generation,
                  snapshotStartSeq: 0,
                  snapshotSeq: output.byteLength,
                  sourceStartSeq: 0,
                  sourceSeq: output.byteLength,
                  snapshotKind: "screen",
                  protocolRevision: 0,
                  modes: { bracketedPaste: false },
                  geometry: { revision: 0, cols: 80, rows: 24 },
                },
              }),
            );
            emitOutputRecord(message.streamId, 2, header);
            emitOutputRecord(message.streamId, 3, output);
          }, 0);
        },
      };

      target.LaymuxNative = {
        requestRemoteHttp(requestId, method, path, bodyJson) {
          if (path === "/remote/v1/session/release") {
            state.releaseRequests.push(JSON.parse(bodyJson!));
            state.heldReleaseRequestId = requestId;
            return;
          }
          if (path.startsWith("/remote/v1/file-viewer/")) {
            state.fileViewerRequests.push({
              method,
              path,
              body: bodyJson ? JSON.parse(bodyJson) : null,
            });
          }
          let body: unknown = {};
          if (path.endsWith("/attachments")) {
            state.attachments.push(JSON.parse(bodyJson!));
            body = { path: "C:\\Temp\\shared.txt" };
          }
          if (path === "/remote/v1/session/status") body = { active: false };
          if (path === "/remote/v1/session/claim") {
            state.claimRequests += 1;
            if (state.holdNextClaim) {
              state.holdNextClaim = false;
              state.heldRequestId = requestId;
              return;
            }
            body = {
              active: true,
              leaseId: "lease-1",
              resumeToken: "resume-1",
              fileViewerToken: "viewer-1",
              heartbeatTimeoutSeconds: 45,
            };
          }
          if (path === "/remote/v1/session/heartbeat") {
            state.heartbeatRequests += 1;
            body = { active: true, leaseId: "lease-1" };
          }
          if (path === "/remote/v1/file-viewer/download") {
            body = {
              name: "notes.txt",
              mediaType: "text/plain",
              base64: "aG9zdCB0ZXh0",
              size: 10,
            };
          }
          if (path === "/remote/v1/file-viewer/status") {
            body = { open: true, path: "C:\\work\\notes.txt" };
          }
          if (path === "/remote/v1/file-viewer/list") {
            body = { path: "C:\\work", parent: "C:\\", entries: [], truncated: false };
          }
          if (path === "/remote/v1/file-viewer/render") {
            state.renderRequests += 1;
            body = {
              kind: "text",
              path: "C:\\work\\notes.txt",
              content: "host text in the wrapper",
              truncated: false,
            };
          }
          if (path === "/remote/v1/navigation") {
            state.navigationRequests += 1;
            if (state.holdNextNavigation) {
              state.holdNextNavigation = false;
              return;
            }
            body = remoteNavigation;
          }
          if (path === "/remote/v1/oauth-relay/begin") {
            state.oauthBeginRequests += 1;
            if (state.holdNextOauthBegin) {
              state.holdNextOauthBegin = false;
              state.heldOauthBeginRequestId = requestId;
              return;
            }
            body = {
              sessionId: `oauth-session-${state.oauthBeginRequests}`,
              port: 4321,
              expiresInSeconds: 600,
            };
          }
          if (path === "/remote/v1/oauth-relay/forward") {
            const request = bodyJson
              ? (JSON.parse(bodyJson) as {
                  leaseId: string;
                  sessionId: string;
                  pathAndQuery: string;
                })
              : { leaseId: "", sessionId: "", pathAndQuery: "" };
            state.oauthForwardRequests.push(request);
            if (state.holdNextOauthForward) {
              state.holdNextOauthForward = false;
              state.heldOauthForwardRequestId = requestId;
              return;
            }
            body = { status: 200, contentType: "text/plain", body: "ok" };
          }
          setTimeout(() => {
            target.laymuxAndroidE2e?.onHttpResponse(
              requestId,
              JSON.stringify({ kind: "http", status: 200, body }),
            );
          }, 0);
        },
        cancelRemoteHttp() {
          state.cancelledRequests += 1;
        },
        cancelSharedFiles(id) {
          state.canceledShares.push(id);
        },
        setRemoteLease(leaseId) {
          state.leases.push(leaseId);
        },
        saveRemoteFile(name, mediaType, base64) {
          // Android's injected Java methods reject calls detached from their bridge.
          if (this !== target.LaymuxNative) {
            throw new Error(
              "Error invoking saveRemoteFile: Java bridge method can't be invoked on a non-injected object",
            );
          }
          state.savedFiles.push({ name, mediaType, base64 });
        },
        openRemoteFile(name, mediaType, base64) {
          if (this !== target.LaymuxNative) {
            throw new Error("openRemoteFile must retain the injected bridge receiver");
          }
          state.openedFiles.push({ name, mediaType, base64 });
        },
        disconnectRemote() {
          state.disconnects += 1;
        },
        beginOauthRelay(sessionId, port, path, authUrl) {
          state.nativeOauthBegins.push({ sessionId, port, path, authUrl });
        },
        cancelOauthRelay() {
          state.nativeOauthCancels += 1;
        },
      };
    },
    { remoteNavigation: fixture, holdInitialClaim: options.holdInitialClaim ?? false },
  );

  await page.route("http://remote.test/remote/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await fulfillRemoteClientAsset(route, path)) return;
    await route.fulfill({ path: `${remoteRoot}${path.replace("/remote/", "")}` });
  });

  await page.goto("http://remote.test/remote/?androidE2e=1&autoConnect=1");
}

for (const reconnectDenied of [false, true]) {
  test(`Android native back releases control before closing the secure session (reconnect denied: ${reconnectDenied})`, async ({
    page,
  }) => {
    await installAndroidRemote(page);
    const state = () =>
      page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
    await expect.poll(async () => (await state()).outputOpens).toBe(1);

    // Execute the actual WebView script shipped by the APK, against the PC bundle.
    const activity = readFileSync(
      new URL(
        "../../apps/android/app/src/main/java/com/laymux/android/MainActivity.kt",
        import.meta.url,
      ),
      "utf8",
    );
    const declaration = activity.match(
      /private const val REMOTE_EXIT_SCRIPT =([\s\S]*?)\n {8}private const val/,
    );
    expect(declaration).not.toBeNull();
    const script = [...declaration![1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
      .map((match) => JSON.parse(match[0]))
      .join("");
    expect(await page.evaluate(script)).toBe(true);
    await expect
      .poll(async () => (await state()).releaseRequests)
      .toEqual([{ leaseId: "lease-1" }]);
    expect(await page.evaluate(script)).toBe(true);
    expect((await state()).disconnects).toBe(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem("laymux.remote.autoConnect")),
    ).toBeNull();

    if (reconnectDenied) {
      await page.evaluate(() => {
        const target = window as AndroidLifecycleWindow;
        target.__androidLifecycleState.holdNextClaim = true;
        document.getElementById("connect")!.click();
      });
      await expect.poll(async () => (await state()).heldRequestId).not.toBeNull();
      await page.evaluate(() => {
        const target = window as AndroidLifecycleWindow;
        target.laymuxAndroidE2e!.onHttpResponse(
          target.__androidLifecycleState.heldRequestId!,
          JSON.stringify({ kind: "http", status: 409, body: { error: "lease conflict" } }),
        );
      });
      await expect(page.locator("#connect")).toBeEnabled();
    }

    await page.evaluate(() => {
      const target = window as AndroidLifecycleWindow;
      target.laymuxAndroidE2e!.onHttpResponse(
        target.__androidLifecycleState.heldReleaseRequestId!,
        JSON.stringify({ kind: "http", status: 200, body: { active: false } }),
      );
    });
    if (reconnectDenied) {
      // Let the superseded Exit settle; another Back must still be able to exit.
      await expect(page.locator("#status")).toContainText("lease conflict");
      expect((await state()).disconnects).toBe(0);
      expect(await page.evaluate(script)).toBe(true);
    }
    await expect.poll(async () => (await state()).disconnects).toBe(1);
  });
}

test("a shared file opens confirmation on the connected terminal and attaches in one tap", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAndroidRemote(page);
  await expect(page.locator("#attachFile")).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
        id: "share-1",
        count: 1,
      }),
    ),
  ).toBe(true);
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).toBeVisible();
  await expect(page.locator("#sharedFilesTarget")).toContainText("Shell");
  await page.screenshot({ path: testInfo.outputPath("shared-file-confirmation.png") });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "여기에 첨부", exact: true }).click();
  const chooser = await chooserPromise;
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxRemoteUi!.takeSharedFileSelection(),
    ),
  ).toBe("share-1");
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxRemoteUi!.takeSharedFileSelection(),
    ),
  ).toBeNull();
  await chooser.setFiles({
    name: "shared.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("shared bytes"),
  });
  await expect(page.locator("#composerInput")).toHaveText("shared.txt");
  const state = await page.evaluate(
    () => (window as AndroidLifecycleWindow).__androidLifecycleState,
  );
  expect(state.claimRequests).toBe(1);
  expect(state.attachments).toHaveLength(1);
  expect(state.attachments[0].leaseId).toBe("lease-1");
});

test("an unconnected shared file waits for terminal readiness then opens confirmation", async ({
  page,
}) => {
  await installAndroidRemote(page, { holdInitialClaim: true });
  await page.evaluate(() =>
    (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
      id: "share-wait",
      count: 2,
    }),
  );
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).not.toBeVisible();
  await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    target.laymuxAndroidE2e!.onHttpResponse(
      target.__androidLifecycleState.heldRequestId!,
      JSON.stringify({
        kind: "http",
        status: 200,
        body: {
          leaseId: "lease-1",
          resumeToken: "resume-1",
          fileViewerToken: "viewer-1",
          heartbeatTimeoutSeconds: 45,
        },
      }),
    );
  });
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).toBeVisible();
  await expect(page.locator("#sharedFilesCount")).toHaveText("공유받은 파일 2개");
});

test("cancel and Android back discard the shared offer without uploading", async ({ page }) => {
  await installAndroidRemote(page);
  await expect(page.locator("#attachFile")).toBeEnabled();
  for (const id of ["cancel-1", "cancel-2"]) {
    await page.evaluate(
      (id) => (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({ id, count: 1 }),
      id,
    );
    if (id === "cancel-1")
      await page.getByRole("button", { name: "첨부 취소", exact: true }).click();
    else expect(await dismissTopRemoteLayer(page)).toBe(true);
    await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).not.toBeVisible();
  }
  const state = await page.evaluate(
    () => (window as AndroidLifecycleWindow).__androidLifecycleState,
  );
  expect(state.canceledShares).toEqual(["cancel-1", "cancel-2"]);
  expect(state.attachments).toEqual([]);
});

test("changing the shared-file PC returns to PC selection without consuming the files", async ({
  page,
}) => {
  await installAndroidRemote(page);
  await expect(page.locator("#attachFile")).toBeEnabled();
  await page.evaluate(() =>
    (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
      id: "other-pc",
      count: 1,
    }),
  );
  await page.getByRole("button", { name: "대상 변경", exact: true }).click();
  await page.getByRole("button", { name: "다른 PC", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
          .releaseRequests.length,
    )
    .toBe(1);
  await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    target.laymuxAndroidE2e!.onHttpResponse(
      target.__androidLifecycleState.heldReleaseRequestId!,
      JSON.stringify({ kind: "http", status: 200, body: {} }),
    );
  });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
          .disconnects,
    )
    .toBe(1);
  expect(
    (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
      .canceledShares,
  ).toEqual([]);
});

test("changing the shared-file terminal confirms the selected target without discarding the files", async ({
  page,
}) => {
  await installAndroidRemote(page, { otherTerminal: true });
  await expect(page.locator("#attachFile")).toBeEnabled();
  await page.evaluate(() =>
    (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
      id: "other-terminal",
      count: 1,
    }),
  );
  await page.getByRole("button", { name: "대상 변경", exact: true }).click();
  await page.getByRole("button", { name: "다른 터미널", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).not.toBeVisible();
  await page.locator('[data-pane-row="pane-2"]').click();
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).toBeVisible();
  await expect(page.locator("#sharedFilesTarget")).toContainText("Pane 2");
  expect(
    (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
      .canceledShares,
  ).toEqual([]);
});

test("a new share replaces the confirmation and keyboard focus stays inside it", async ({
  page,
}) => {
  await installAndroidRemote(page);
  await expect(page.locator("#attachFile")).toBeEnabled();
  await page.evaluate(() => {
    const ui = (window as AndroidLifecycleWindow).laymuxRemoteUi!;
    ui.offerSharedFiles({ id: "old-share", count: 1 });
    ui.offerSharedFiles({ id: "new-share", count: 3 });
  });
  await expect(page.locator("#sharedFilesCount")).toHaveText("공유받은 파일 3개");
  await expect(page.locator("#sharedFilesAttach")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#sharedFilesCancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "공유 파일 첨부" })).not.toBeVisible();
  expect(
    (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
      .canceledShares,
  ).toEqual(["new-share"]);
});

test("a replaced share cannot be consumed by a pending older chooser", async ({ page }) => {
  await installAndroidRemote(page);
  await expect(page.locator("#attachFile")).toBeEnabled();
  await page.evaluate(() =>
    (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
      id: "old-selection",
      count: 1,
    }),
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "여기에 첨부", exact: true }).click();
  await chooserPromise;
  await page.evaluate(() =>
    (window as AndroidLifecycleWindow).laymuxRemoteUi!.offerSharedFiles({
      id: "new-selection",
      count: 2,
    }),
  );
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxRemoteUi!.takeSharedFileSelection(),
    ),
  ).toBe(false);
  await expect(page.locator("#sharedFilesCount")).toHaveText("공유받은 파일 2개");
  expect(
    (await page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState))
      .attachments,
  ).toEqual([]);
});

test("Android gallery selection survives background longer than the heartbeat deadline", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect(page.locator("#composerInput")).toBeEnabled();
  await page.locator("#keyBarToggle").click();
  const selected = page.waitForEvent("filechooser");
  await page.locator("#attachFile").click();
  const chooser = await selected;
  await page.clock.install();
  const heartbeatBefore = (await state()).heartbeatRequests;
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxAndroidE2e?.onNativeBackground?.(),
    ),
  ).toBe(true);
  await page.clock.fastForward(90_000);
  expect((await state()).heartbeatRequests).toBe(heartbeatBefore);
  expect((await state()).leases).toEqual(["lease-1"]);
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxAndroidE2e?.onNativeForeground?.(),
    ),
  ).toBe(true);
  await chooser.setFiles({
    name: "gallery.png",
    mimeType: "image/png",
    buffer: Buffer.from("gallery bytes"),
  });
  await page.clock.runFor(2_000);
  await expect.poll(async () => (await state()).attachments.length).toBe(1);
  expect((await state()).attachments[0]).toMatchObject({
    leaseId: "lease-1",
    fileName: "gallery.png",
  });
  expect((await state()).claimRequests).toBe(1);
  await expect(page.locator(".composer-attachment")).toHaveAttribute("aria-label", "gallery.png");
});

test("Android foreground resumes transport without reloading the Remote document", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);

  await expect.poll(async () => (await state()).outputOpens).toBe(1);
  const composer = page.locator("#composerInput");
  await expect(composer).toBeEnabled();
  await composer.fill("draft survives background");

  await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    target.__androidLifecycleState.holdNextNavigation = true;
    (document.getElementById("refresh") as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await state()).navigationRequests).toBe(2);

  const heartbeatBefore = (await state()).heartbeatRequests;
  const handled = await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    target.__remoteDocumentSentinel = {};
    window.dispatchEvent(new Event("pagehide"));
    if (sessionStorage.getItem("laymux.remote.resumeToken") !== "resume-1") {
      throw new Error("pagehide did not stash the resume capability");
    }
    return target.laymuxAndroidE2e?.onNativeForeground?.();
  });

  expect(handled).toBe(true);
  await expect.poll(async () => (await state()).cancelledRequests).toBe(1);
  await expect.poll(async () => (await state()).outputOpens).toBe(2);
  await expect.poll(async () => (await state()).heartbeatRequests).toBeGreaterThan(heartbeatBefore);
  await expect(composer).toHaveText("draft survives background");
  expect(await page.evaluate(() => sessionStorage.getItem("laymux.remote.resumeToken"))).toBeNull();
  expect(
    await page.evaluate(() => Boolean((window as AndroidLifecycleWindow).__remoteDocumentSentinel)),
  ).toBe(true);
});

test("Android foreground retries an auto-connect interrupted before the first lease", async ({
  page,
}) => {
  await installAndroidRemote(page, { holdInitialClaim: true });
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);

  await expect.poll(async () => (await state()).claimRequests).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as AndroidLifecycleWindow).laymuxAndroidE2e?.onNativeForeground?.(),
    ),
  ).toBe(true);

  await expect.poll(async () => (await state()).cancelledRequests).toBe(1);
  await expect.poll(async () => (await state()).claimRequests).toBe(2);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);
  expect((await state()).leases).toContain("lease-1");
});

test("Android foreground delivers a resumed claim before rejecting stale requests", async ({
  page,
}) => {
  await installAndroidRemote(page, { holdInitialClaim: true });
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);

  await expect.poll(async () => (await state()).claimRequests).toBe(1);
  const handled = await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    const requestId = target.__androidLifecycleState.heldRequestId;
    if (!requestId) throw new Error("claim request was not retained for native resume");
    target.laymuxAndroidE2e?.onHttpResponse(
      requestId,
      JSON.stringify({
        kind: "http",
        status: 200,
        body: {
          active: true,
          leaseId: "lease-1",
          resumeToken: "resume-1",
          heartbeatTimeoutSeconds: 45,
        },
      }),
    );
    return target.laymuxAndroidE2e?.onNativeForeground?.();
  });

  expect(handled).toBe(true);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);
  expect((await state()).claimRequests).toBe(1);
  expect((await state()).cancelledRequests).toBe(0);
  expect((await state()).leases).toContain("lease-1");
});

test("the Android wrapper gets the file viewer, rendered in the Remote document", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);

  // Android uses the same in-overlay explorer and path controls as browsers.
  await page.locator("#fileExplorerHeader").click();
  await expect(page.locator("#fileViewerSection")).toBeVisible();
  await page.locator("#pullHostFileViewerPath").click();
  await expect(page.locator("#fileViewerPath")).toHaveValue("C:\\work\\notes.txt");
  expect(
    (await state()).fileViewerRequests.find(
      (request) => request.path === "/remote/v1/file-viewer/status",
    ),
  ).toEqual({
    method: "POST",
    path: "/remote/v1/file-viewer/status",
    body: {
      fileViewerAuthorization: {
        leaseId: "lease-1",
        fileViewerToken: "viewer-1",
      },
    },
  });
  await page.locator("#openFileViewer").click();

  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#fileViewerText")).toHaveText("host text in the wrapper");
  expect((await state()).renderRequests).toBe(1);
  expect(
    (await state()).fileViewerRequests.find(
      (request) => request.path === "/remote/v1/file-viewer/render",
    ),
  ).toEqual({
    method: "POST",
    path: "/remote/v1/file-viewer/render",
    body: {
      source: "path",
      path: "C:\\work\\notes.txt",
      fileViewerAuthorization: {
        leaseId: "lease-1",
        fileViewerToken: "viewer-1",
      },
    },
  });

  await page.locator("#fileViewerClose").click();
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
});

test("Android back dismisses the top Remote layer before the disconnect guard", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);

  // Composer suggestions float above the terminal content, but their parent
  // stacking context stays below the drawer. A widget can open navigation
  // without blurring the composer, so exercise the real simultaneous state.
  const composer = page.locator("#composerInput");
  await composer.fill("echo remembered");
  await composer.press("Control+Enter"); // composer.remote.send (ADR-0269)
  await expect(composer).toHaveText("");
  await composer.fill("echo");
  await expect(page.locator("#composerAutocompleteList")).toBeVisible();

  await page.locator("#navToggle").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator(".app")).toHaveClass(/nav-open/);
  await expect(page.locator("#composerAutocompleteList")).toBeVisible();
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator(".app")).not.toHaveClass(/nav-open/);
  await expect(page.locator("#composerAutocompleteList")).toBeVisible();
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#composerAutocompleteList")).toBeHidden();

  await page.locator("#fileExplorerHeader").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.txt");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  // The OAuth confirmation is the only Remote modal that can sit above the
  // viewer. Closing it first also cancels any native loopback listener.
  await page.locator("#oauthRelayScrim").evaluate((scrim) => {
    scrim.hidden = false;
  });
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#oauthRelayScrim")).toBeHidden();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#fileViewerDirectory")).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText("C:\\work");
  await expect(page.locator("#fileViewerText")).toBeHidden();

  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  await expect(page.locator(".app")).not.toHaveClass(/nav-open/);

  await page.locator("#navToggle").click();
  await expect(page.locator(".app")).toHaveClass(/nav-open/);

  // Drawer subpages form a real nested level: one back returns to the Remote
  // workspace page, while the next visible nested level (Dock) collapses before
  // a final back closes the drawer itself.
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#drawerSettingsView")).toBeVisible();
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#drawerWorkspaceView")).toBeVisible();
  await expect(page.locator(".app")).toHaveClass(/nav-open/);

  await page.locator("#dockToggle").evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
  });
  await page.locator("#dockToggle").click();
  await expect(page.locator("#dockPanel")).toBeVisible();
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#dockPanel")).toBeHidden();
  await expect(page.locator(".app")).toHaveClass(/nav-open/);

  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator(".app")).not.toHaveClass(/nav-open/);
  expect(await dismissTopRemoteLayer(page)).toBe(false);
});

test("Android back invalidates an OAuth relay that is still registering", async ({ page }) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);

  const authUrl =
    "https://login.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fcallback";
  await page.evaluate((url) => {
    const target = window as AndroidLifecycleWindow;
    target.__androidLifecycleState.holdNextOauthBegin = true;
    if (!target.__activateRemoteUrl) throw new Error("Remote URL activation was not captured");
    target.__activateRemoteUrl(url);
  }, authUrl);
  await expect(page.locator("#oauthRelayScrim")).toBeVisible();

  await page.locator("#oauthRelayStart").click();
  await expect.poll(async () => (await state()).oauthBeginRequests).toBe(1);
  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#oauthRelayScrim")).toBeHidden();

  await page.evaluate(async () => {
    const target = window as AndroidLifecycleWindow;
    const requestId = target.__androidLifecycleState.heldOauthBeginRequestId;
    if (!requestId) throw new Error("OAuth begin request was not retained");
    target.laymuxAndroidE2e?.onHttpResponse(
      requestId,
      JSON.stringify({
        kind: "http",
        status: 200,
        body: { sessionId: "oauth-session-1", port: 4321, expiresInSeconds: 600 },
      }),
    );
    // Let the awaiting begin flow run before observing whether it launched native.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  expect((await state()).nativeOauthBegins).toEqual([]);
  expect((await state()).nativeOauthCancels).toBe(1);
  await expect(page.locator("#oauthRelayScrim")).toBeHidden();
});

test("a stale OAuth forward cannot clear a newer relay opened after back", async ({ page }) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);

  const activateOauth = async (url: string) => {
    await page.evaluate((nextUrl) => {
      const target = window as AndroidLifecycleWindow;
      if (!target.__activateRemoteUrl) throw new Error("Remote URL activation was not captured");
      target.__activateRemoteUrl(nextUrl);
    }, url);
    await expect(page.locator("#oauthRelayScrim")).toBeVisible();
    await page.locator("#oauthRelayStart").click();
  };
  const authUrl =
    "https://login.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fcallback";

  await activateOauth(authUrl);
  await expect.poll(async () => (await state()).nativeOauthBegins).toHaveLength(1);
  await page.evaluate(() => {
    const target = window as AndroidLifecycleWindow;
    target.__androidLifecycleState.holdNextOauthForward = true;
    target.laymuxOauthRelay?.onCallback("/callback?code=old");
  });
  await expect.poll(async () => (await state()).oauthForwardRequests).toHaveLength(1);

  expect(await dismissTopRemoteLayer(page)).toBe(true);
  await expect(page.locator("#oauthRelayScrim")).toBeHidden();
  await activateOauth(authUrl);
  await expect.poll(async () => (await state()).nativeOauthBegins).toHaveLength(2);

  await page.evaluate(async () => {
    const target = window as AndroidLifecycleWindow;
    const requestId = target.__androidLifecycleState.heldOauthForwardRequestId;
    if (!requestId) throw new Error("OAuth forward request was not retained");
    target.laymuxAndroidE2e?.onHttpResponse(
      requestId,
      JSON.stringify({
        kind: "http",
        status: 200,
        body: { status: 200, contentType: "text/plain", body: "ok" },
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    target.laymuxOauthRelay?.onCallback("/callback?code=new");
  });

  await expect.poll(async () => (await state()).oauthForwardRequests).toHaveLength(2);
  expect((await state()).oauthForwardRequests).toEqual([
    { leaseId: "lease-1", sessionId: "oauth-session-1", pathAndQuery: "/callback?code=old" },
    { leaseId: "lease-1", sessionId: "oauth-session-2", pathAndQuery: "/callback?code=new" },
  ]);
  await expect(page.locator("#oauthRelayStatus")).toContainText("200");
});

test("the Android wrapper opens files through native and explains an outdated APK", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);
  await page.locator("#fileExplorerHeader").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.txt");
  await page.locator("#openFileViewer").click();
  await page.locator("#fileViewerOpen").click();
  await expect
    .poll(async () => (await state()).openedFiles)
    .toEqual([{ name: "notes.txt", mediaType: "text/plain", base64: "aG9zdCB0ZXh0" }]);
  expect((await state()).savedFiles).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  const before = (await state()).fileViewerRequests.length;
  await page.evaluate(() => {
    delete (window as AndroidLifecycleWindow).LaymuxNative.openRemoteFile;
  });
  await page.locator("#fileViewerOpen").click();
  await expect(page.locator("#fileViewerMessage")).toHaveText(
    "This app version cannot open files. Update the app.",
  );
  expect((await state()).fileViewerRequests).toHaveLength(before);
});

test("the Android wrapper saves a download through native, not the browser path", async ({
  page,
}) => {
  await installAndroidRemote(page);
  const state = () =>
    page.evaluate(() => (window as AndroidLifecycleWindow).__androidLifecycleState);
  await expect.poll(async () => (await state()).outputOpens).toBe(1);

  await page.locator("#fileExplorerHeader").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.txt");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  // The WebView has no download handler, so `<a download>` would be a silent
  // no-op: the bytes have to reach native (ADR-0185).
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.locator("#fileViewerDownload").click();

  await expect(page.locator("#fileViewerMessage")).toHaveText("Saved notes.txt to Downloads.");
  expect((await state()).savedFiles).toEqual([
    { name: "notes.txt", mediaType: "text/plain", base64: "aG9zdCB0ZXh0" },
  ]);
  expect(
    (await state()).fileViewerRequests.find(
      (request) => request.path === "/remote/v1/file-viewer/download",
    ),
  ).toEqual({
    method: "POST",
    path: "/remote/v1/file-viewer/download",
    body: {
      path: "C:\\work\\notes.txt",
      fileViewerAuthorization: {
        leaseId: "lease-1",
        fileViewerToken: "viewer-1",
      },
    },
  });
  expect(downloads).toBe(0);
});
