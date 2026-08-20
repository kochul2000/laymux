import { expect, test, type FilePayload, type Page, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

interface AttachmentRequest {
  leaseId: string;
  fileName: string;
  mimeType: string;
  data: string;
}

interface TerminalInputRequest {
  leaseId: string;
  text: string;
  submit: boolean;
}

async function chooseAttachmentFiles(page: Page, files: FilePayload | FilePayload[]) {
  await page.locator("#attachFile").evaluate((element: HTMLButtonElement) => element.click());
  await page.locator("#attachmentInput").setInputFiles(files);
}

async function openRemote(
  page: Page,
  inputMode: "composer" | "direct",
  options: {
    failFirstAttachment?: boolean;
    stallFirstAttachment?: boolean;
    stallFirstTerminalInput?: boolean;
    stallRelease?: boolean;
    attachmentZone?: "main" | "expanded";
  } = {},
): Promise<{
  attachments: AttachmentRequest[];
  terminalInputs: TerminalInputRequest[];
  releaseFirstAttachment: () => void;
  releaseFirstTerminalInput: () => void;
  releaseLeaseRequest: () => void;
  releaseRequests: () => number;
  outputSocketRevision: () => number;
  sendOutputSnapshot: () => void;
}> {
  const attachments: AttachmentRequest[] = [];
  const terminalInputs: TerminalInputRequest[] = [];
  let outputSocket: WebSocketRoute | null = null;
  let outputSocketRevision = 0;
  let claimCount = 0;
  let releaseRequestCount = 0;
  let releaseFirstAttachment = () => {};
  let releaseFirstTerminalInput = () => {};
  let releaseLeaseRequest = () => {};
  const firstAttachmentGate = new Promise<void>((resolve) => {
    releaseFirstAttachment = resolve;
  });
  const firstTerminalInputGate = new Promise<void>((resolve) => {
    releaseFirstTerminalInput = resolve;
  });
  const releaseLeaseGate = new Promise<void>((resolve) => {
    releaseLeaseRequest = resolve;
  });

  await page.addInitScript(
    ({ mode, attachmentZone }) => {
      localStorage.setItem("laymux.remote.inputMode", mode);
      if (attachmentZone) {
        localStorage.setItem(
          "laymux.remote.keybar",
          JSON.stringify({
            zones: {
              main: attachmentZone === "main" ? ["attachment"] : [],
              expanded: attachmentZone === "expanded" ? ["attachment"] : [],
              hidden: [],
            },
          }),
        );
      }
    },
    { mode: inputMode, attachmentZone: options.attachmentZone },
  );
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      claimCount += 1;
      await route.fulfill({
        json: {
          leaseId: `lease-${claimCount}`,
          resumeToken: `resume-${claimCount}`,
          fileViewerToken: `viewer-${claimCount}`,
          heartbeatTimeoutSeconds: 45,
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/release") {
      releaseRequestCount += 1;
      if (options.stallRelease) await releaseLeaseGate;
      await route.fulfill({ json: {} });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({
        json: {
          terminals: [{ id: "term-1", title: "Shell", profile: "PowerShell", appearance: {} }],
          activeWorkspace: {
            id: "ws-1",
            name: "Main",
            focusedPaneNumber: 1,
            panes: [
              {
                id: "pane-1",
                paneNumber: 1,
                terminalId: "term-1",
                terminalLive: true,
                viewType: "TerminalView",
              },
            ],
          },
          workspaces: [],
          docks: [],
          notifications: [],
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/terminals/term-1/attachments") {
      const body = route.request().postDataJSON() as AttachmentRequest;
      attachments.push(body);
      if (options.stallFirstAttachment && attachments.length === 1) {
        await firstAttachmentGate;
      }
      if (options.failFirstAttachment && attachments.length === 1) {
        await route.fulfill({ status: 500, json: { error: "forced attachment failure" } });
        return;
      }
      await route.fulfill({
        json: {
          path: `C:\\Temp\\remote-${attachments.length}-${body.fileName}`,
          byteLength: Buffer.from(body.data, "base64").byteLength,
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/terminals/term-1/input") {
      terminalInputs.push(route.request().postDataJSON() as TerminalInputRequest);
      if (options.stallFirstTerminalInput && terminalInputs.length === 1) {
        await firstTerminalInputGate;
      }
    }
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
    outputSocket = socket;
    outputSocketRevision += 1;
  });

  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect.poll(() => outputSocket).not.toBeNull();
  const sendOutputSnapshot = () => {
    outputSocket!.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "snapshot",
        seqStart: 0,
        seqEnd: 0,
        byteLength: 0,
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: 0,
          sourceStartSeq: 0,
          sourceSeq: 0,
          snapshotKind: "screen",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols: 80, rows: 24 },
        },
      }),
    );
    outputSocket!.send(Buffer.alloc(0));
  };
  sendOutputSnapshot();
  await expect(page.locator("#attachFile")).toBeEnabled();

  return {
    attachments,
    terminalInputs,
    releaseFirstAttachment,
    releaseFirstTerminalInput,
    releaseLeaseRequest,
    releaseRequests: () => releaseRequestCount,
    outputSocketRevision: () => outputSocketRevision,
    sendOutputSnapshot,
  };
}

test.describe("remote terminal attachments", () => {
  test("opens the file chooser after Attach file is moved to the main row", async ({ page }) => {
    const { attachments } = await openRemote(page, "composer", { attachmentZone: "main" });
    await expect(page.locator("#mainActionRow > #attachFile")).toBeVisible();

    await chooseAttachmentFiles(page, {
      name: "moved.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("moved attachment", "utf8"),
    });

    await expect.poll(() => attachments.length).toBe(1);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-1-moved.txt");
  });

  test("uploads selected image and text files and inserts their host paths into the composer", async ({
    page,
  }) => {
    const { attachments, terminalInputs } = await openRemote(page, "composer");

    await chooseAttachmentFiles(page, [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("remote notes", "utf8"),
      },
      {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);

    await expect.poll(() => attachments.length).toBe(2);
    expect(attachments.map(({ fileName, mimeType }) => ({ fileName, mimeType }))).toEqual([
      { fileName: "notes.txt", mimeType: "text/plain" },
      { fileName: "pixel.png", mimeType: "image/png" },
    ]);
    expect(Buffer.from(attachments[0].data, "base64").toString("utf8")).toBe("remote notes");
    await expect(page.locator("#composerInput")).toHaveValue(
      "C:\\Temp\\remote-1-notes.txt C:\\Temp\\remote-2-pixel.png",
    );
    expect(terminalInputs).toEqual([]);
  });

  test("uploads a chooser result when Android returns without a change event", async ({ page }) => {
    const { attachments } = await openRemote(page, "composer");

    await page.locator("#attachmentInput").evaluate((element: HTMLInputElement) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["android chooser"], "android.txt", { type: "text/plain" }));
      (document.querySelector("#attachFile") as HTMLButtonElement).click();
      window.dispatchEvent(new Event("focus"));
      window.setTimeout(() => {
        element.files = transfer.files;
      }, 50);
    });

    await expect.poll(() => attachments.length).toBe(1);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-1-android.txt");
  });

  test("does not carry a chooser focus retry into a replacement lease", async ({ page }) => {
    const { attachments, outputSocketRevision, sendOutputSnapshot } = await openRemote(
      page,
      "composer",
    );

    await page.locator("#attachmentInput").evaluate(() => {
      (document.querySelector("#attachFile") as HTMLButtonElement).click();
      window.dispatchEvent(new Event("focus"));
    });

    await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
    await page.locator("#connect").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await page.locator("#attachmentInput").evaluate((element: HTMLInputElement) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["stale chooser"], "stale.txt", { type: "text/plain" }));
      element.files = transfer.files;
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(300);

    expect(attachments).toEqual([]);
    await expect(page.locator("#composerInput")).toHaveValue("");
    await page.locator("#attachmentInput").evaluate((element: HTMLInputElement) => {
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    expect(attachments).toEqual([]);
  });

  test("converts a long composer paste into a text attachment instead of retaining the body", async ({
    page,
  }) => {
    const { attachments, terminalInputs } = await openRemote(page, "composer");
    const pastedText = "긴 텍스트 line\n".repeat(500);

    await page.locator("#composerInput").evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    }, pastedText);

    await expect.poll(() => attachments.length).toBe(1);
    expect(attachments[0].fileName).toBe("pasted-text.txt");
    expect(attachments[0].mimeType).toBe("text/plain");
    expect(Buffer.from(attachments[0].data, "base64").toString("utf8")).toBe(pastedText);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-1-pasted-text.txt");
    expect(terminalInputs).toEqual([]);
  });

  test("pastes an attached path through structured input in direct mode", async ({ page }) => {
    const { attachments, terminalInputs } = await openRemote(page, "direct");

    await chooseAttachmentFiles(page, {
      name: "prompt.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Prompt", "utf8"),
    });

    await expect.poll(() => attachments.length).toBe(1);
    await expect
      .poll(() => terminalInputs)
      .toEqual([
        {
          leaseId: "lease-1",
          text: "C:\\Temp\\remote-1-prompt.md",
          submit: false,
        },
      ]);
  });

  test("disconnect aborts a stalled upload and a new lease can attach immediately", async ({
    page,
  }) => {
    const { attachments, releaseFirstAttachment, outputSocketRevision, sendOutputSnapshot } =
      await openRemote(page, "composer", { stallFirstAttachment: true });

    await chooseAttachmentFiles(page, {
      name: "stalled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stalled", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(1);

    await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
    await page.locator("#connect").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await expect(page.locator("#attachFile")).toBeEnabled();

    await chooseAttachmentFiles(page, {
      name: "fresh.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fresh", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(2);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-2-fresh.txt");
    releaseFirstAttachment();
    await page.waitForTimeout(50);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-2-fresh.txt");
    await expect(page.locator("#attachFile")).toBeEnabled();
  });

  test("bfcache pagehide cancels a stalled upload before reclaiming", async ({ page }) => {
    const { attachments, releaseFirstAttachment, outputSocketRevision, sendOutputSnapshot } =
      await openRemote(page, "composer", { stallFirstAttachment: true });

    await chooseAttachmentFiles(page, {
      name: "stalled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stalled", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(1);
    await expect(page.locator("#attachFile")).toHaveAttribute("aria-busy", "true");

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("#attachFile")).toHaveAttribute("aria-busy", "false");
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await expect(page.locator("#attachFile")).toBeEnabled();

    await chooseAttachmentFiles(page, {
      name: "fresh.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fresh", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(2);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-2-fresh.txt");

    releaseFirstAttachment();
    await page.waitForTimeout(50);
    await expect(page.locator("#composerInput")).toHaveValue("C:\\Temp\\remote-2-fresh.txt");
    await expect(page.locator("#attachFile")).toBeEnabled();
  });

  test("exit cancellation and a late release cannot overwrite a new lease", async ({ page }) => {
    const {
      attachments,
      releaseFirstAttachment,
      releaseLeaseRequest,
      releaseRequests,
      outputSocketRevision,
      sendOutputSnapshot,
    } = await openRemote(page, "composer", {
      stallFirstAttachment: true,
      stallRelease: true,
    });

    await chooseAttachmentFiles(page, {
      name: "stalled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stalled", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(1);
    await expect(page.locator("#attachFile")).toHaveAttribute("aria-busy", "true");

    await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(releaseRequests).toBe(1);
    await expect(page.locator("#attachFile")).toHaveAttribute("aria-busy", "false");

    await page.locator("#connect").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await expect(page.locator("#attachFile")).toBeEnabled();
    await chooseAttachmentFiles(page, {
      name: "fresh.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fresh", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(2);
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");

    releaseFirstAttachment();
    releaseLeaseRequest();
    await page.waitForTimeout(50);
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");
    await expect(page.locator("#attachFile")).toBeEnabled();
  });

  test("a canceled direct attachment input cannot overwrite the next lease", async ({ page }) => {
    const {
      attachments,
      terminalInputs,
      releaseFirstTerminalInput,
      outputSocketRevision,
      sendOutputSnapshot,
    } = await openRemote(page, "direct", { stallFirstTerminalInput: true });

    await chooseAttachmentFiles(page, {
      name: "stalled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stalled", "utf8"),
    });
    await expect.poll(() => terminalInputs.length).toBe(1);
    expect(terminalInputs[0].leaseId).toBe("lease-1");

    await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
    await page.locator("#connect").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await expect(page.locator("#attachFile")).toBeEnabled();

    await chooseAttachmentFiles(page, {
      name: "fresh.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fresh", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(2);
    await expect.poll(() => terminalInputs.length).toBe(2);
    expect(terminalInputs[1]).toEqual({
      leaseId: "lease-2",
      text: "C:\\Temp\\remote-2-fresh.txt",
      submit: false,
    });
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");

    releaseFirstTerminalInput();
    await page.waitForTimeout(50);
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");
    await expect(page.locator("#attachFile")).toBeEnabled();
  });

  test("a canceled long-paste fallback cannot overwrite the next lease", async ({ page }) => {
    const {
      attachments,
      terminalInputs,
      releaseFirstTerminalInput,
      outputSocketRevision,
      sendOutputSnapshot,
    } = await openRemote(page, "direct", {
      failFirstAttachment: true,
      stallFirstTerminalInput: true,
    });
    const pastedText = "fallback text\n".repeat(400);

    await page.locator("#terminal").evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    }, pastedText);
    await expect.poll(() => attachments.length).toBe(1);
    await expect.poll(() => terminalInputs.length).toBe(1);
    expect(terminalInputs[0]).toEqual({ leaseId: "lease-1", text: pastedText, submit: false });

    await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
    await page.locator("#connect").evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(outputSocketRevision).toBe(2);
    sendOutputSnapshot();
    await expect(page.locator("#attachFile")).toBeEnabled();

    await chooseAttachmentFiles(page, {
      name: "fresh.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fresh", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(2);
    await expect.poll(() => terminalInputs.length).toBe(2);
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");

    releaseFirstTerminalInput();
    await page.waitForTimeout(50);
    await expect(page.locator("#status")).toHaveText("Attached fresh.txt.");
    await expect(page.locator("#attachFile")).toBeEnabled();
  });

  test("rejects a second long direct paste while an attachment upload is busy", async ({
    page,
  }) => {
    const { attachments, terminalInputs, releaseFirstAttachment } = await openRemote(
      page,
      "direct",
      { stallFirstAttachment: true },
    );
    await chooseAttachmentFiles(page, {
      name: "stalled.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stalled", "utf8"),
    });
    await expect.poll(() => attachments.length).toBe(1);

    const pastedText = "second long paste\n".repeat(400);
    await page.locator("#terminal").evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    }, pastedText);

    expect(attachments).toHaveLength(1);
    expect(terminalInputs).toEqual([]);
    await expect(page.locator("#status")).toContainText("attachment upload is already in progress");
    releaseFirstAttachment();
  });
});
