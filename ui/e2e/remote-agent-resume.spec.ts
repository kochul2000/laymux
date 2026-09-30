import { test, expect, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test.use({ viewport: { width: 420, height: 800 }, hasTouch: true });

test("동일 좌표의 연속 터치가 최신 복원 안내와 호스트 옵션을 제출한다", async ({ page }) => {
  let output: WebSocketRoute | undefined;
  const submissions: Array<{ text: string; submit: boolean; leaseId: string }> = [];
  await page.addInitScript(() => {
    let Constructor: unknown;
    Object.defineProperty(window, "Terminal", {
      configurable: true,
      get: () => Constructor,
      set: (value) => {
        Constructor = class extends value {
          constructor(...args: unknown[]) {
            super(...args);
            (window as unknown as { resumeTerminal: unknown }).resumeTerminal = this;
          }
        };
      },
    });
  });
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session/claim")) {
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
    } else if (url.pathname.endsWith("/navigation")) {
      await route.fulfill({
        json: {
          terminals: [
            {
              id: "term-1",
              title: "Shell",
              appearance: {},
              activity: { type: "shell" },
              commandRunning: false,
            },
          ],
          activeWorkspace: {
            focusedPaneNumber: 1,
            panes: [
              { paneNumber: 1, terminalId: "term-1", terminalLive: true, viewType: "TerminalView" },
            ],
          },
          workspaces: [],
          docks: [],
          notifications: [],
          agentCommands: {
            codex: { command: "codex --yolo --no-daemon" },
            claude: { command: "claude --dangerously-skip-permissions" },
            grok: { command: "grok --yolo" },
          },
        },
      });
    } else {
      if (url.pathname.endsWith("/input")) submissions.push(route.request().postDataJSON());
      await route.fulfill({ json: {} });
    }
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
    output = socket;
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect.poll(() => Boolean(output)).toBe(true);
  output!.send(
    JSON.stringify({
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
    }),
  );
  output!.send(Buffer.alloc(0));
  await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
  const id = "11111111-2222-4333-8444-555555555555";
  let seq = 0;
  for (const [index, provider] of ["codex", "claude", "grok"].entries()) {
    const hint = `${provider} ${provider === "codex" ? "resume" : "--resume"} ${id}`;
    const payload = Buffer.from(`\x1b[2J\x1b[HResume this session with:\r\n  ${hint}\r\n`);
    output!.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "delta",
        seqStart: seq,
        seqEnd: seq + payload.length,
        byteLength: payload.length,
      }),
    );
    output!.send(payload);
    seq += payload.length;
    await page.waitForFunction((provider) => {
      const terminal = (
        window as unknown as {
          resumeTerminal: {
            buffer: { active: { getLine: (line: number) => { translateToString: () => string } } };
          };
        }
      ).resumeTerminal;
      return terminal.buffer.active.getLine(1).translateToString().includes(provider);
    }, provider);
    const rect = await page.locator("#terminal .xterm-screen").boundingBox();
    const geometry = await page.evaluate(() => {
      const terminal = (window as unknown as { resumeTerminal: { cols: number; rows: number } })
        .resumeTerminal;
      return { cols: terminal.cols, rows: terminal.rows };
    });
    // 사전 hover 없이 정확히 같은 셀을 연속 탭한다.
    await page.touchscreen.tap(
      rect!.x + (3.5 * rect!.width) / geometry.cols,
      rect!.y + (1.5 * rect!.height) / geometry.rows,
    );
    await expect.poll(() => submissions.length).toBe(index + 1);
    const command =
      provider === "codex"
        ? "codex --yolo --no-daemon resume"
        : provider === "claude"
          ? "claude --dangerously-skip-permissions --resume"
          : "grok --yolo --resume";
    expect(submissions[index]).toEqual({
      leaseId: "lease-1",
      text: `${command} ${id}`,
      submit: true,
    });
    // 일반 링크 탭을 검증한다. 의도된 double/triple tap 선택 시간창은 넘긴다.
    await page.waitForTimeout(700);
  }
});
