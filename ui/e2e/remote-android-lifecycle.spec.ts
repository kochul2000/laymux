import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

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
  heldRequestId: string | null;
  holdNextClaim: boolean;
  holdNextNavigation: boolean;
  navigationRequests: number;
  outputOpens: number;
  leases: Array<string | null>;
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
    disconnectRemote: () => void;
  };
  LaymuxOutputTransport: {
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    postMessage: (message: string) => void;
  };
  laymuxAndroidE2e?: {
    onHttpResponse: (requestId: string, responseJson: string) => void;
    onNativeForeground?: () => boolean;
  };
  __androidLifecycleState: AndroidLifecycleState;
  __remoteDocumentSentinel?: object;
};

async function installAndroidRemote(page: Page, options: { holdInitialClaim?: boolean } = {}) {
  await page.addInitScript(
    ({ remoteNavigation, holdInitialClaim }) => {
      localStorage.setItem("laymux.remote.inputMode", "composer");

      const target = window as AndroidLifecycleWindow;
      const state: AndroidLifecycleState = {
        cancelledRequests: 0,
        claimRequests: 0,
        heartbeatRequests: 0,
        heldRequestId: null,
        holdNextClaim: holdInitialClaim,
        holdNextNavigation: false,
        navigationRequests: 0,
        outputOpens: 0,
        leases: [],
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
        requestRemoteHttp(requestId, _method, path) {
          let body: unknown = {};
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
              heartbeatTimeoutSeconds: 45,
            };
          }
          if (path === "/remote/v1/session/heartbeat") {
            state.heartbeatRequests += 1;
            body = { active: true, leaseId: "lease-1" };
          }
          if (path === "/remote/v1/navigation") {
            state.navigationRequests += 1;
            if (state.holdNextNavigation) {
              state.holdNextNavigation = false;
              return;
            }
            body = remoteNavigation;
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
        setRemoteLease(leaseId) {
          state.leases.push(leaseId);
        },
        disconnectRemote() {},
      };
    },
    { remoteNavigation: navigation, holdInitialClaim: options.holdInitialClaim ?? false },
  );

  await page.route("http://remote.test/remote/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const asset = path === "/remote/" ? "page.html" : path.replace("/remote/vendor/", "assets/");
    await route.fulfill({ path: `${remoteRoot}${asset}` });
  });

  await page.goto("http://remote.test/remote/?androidE2e=1&autoConnect=1");
}

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
  await expect(composer).toHaveValue("draft survives background");
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
