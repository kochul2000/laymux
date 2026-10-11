import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test.use({ viewport: { width: 420, height: 800 }, hasTouch: true });

type HostTerminal = { activity: { type: string; name?: string }; commandRunning: boolean };

async function openResumeRemote(
  page: Page,
  host: HostTerminal = { activity: { type: "shell" }, commandRunning: false },
) {
  let output: WebSocketRoute | undefined;
  const submissions: Array<{ text: string; submit: boolean; leaseId: string }> = [];
  const navigationReads = { count: 0 };
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
      navigationReads.count += 1;
      await route.fulfill({
        json: {
          terminals: [
            {
              id: "term-1",
              title: "Shell",
              appearance: {},
              activity: host.activity,
              commandRunning: host.commandRunning,
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
  return { output: output!, submissions, navigationReads };
}

test("동일 좌표의 연속 터치가 최신 복원 안내와 호스트 옵션을 제출한다", async ({ page }) => {
  const { output, submissions } = await openResumeRemote(page);
  const id = "11111111-2222-4333-8444-555555555555";
  let seq = 0;
  for (const [index, provider] of ["codex", "claude", "grok"].entries()) {
    const hint = `${provider} ${provider === "codex" ? "resume" : "--resume"} ${id}`;
    const payload = Buffer.from(`\x1b[2J\x1b[HResume this session with:\r\n  ${hint}\r\n`);
    output.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "delta",
        seqStart: seq,
        seqEnd: seq + payload.length,
        byteLength: payload.length,
      }),
    );
    output.send(payload);
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

async function showResumeHintAndTap(page: Page, output: WebSocketRoute, hint: string) {
  const payload = Buffer.from(`\x1b[2J\x1b[H^C\r\nResume this session with:\r\n${hint}\r\n$ `);
  output.send(
    JSON.stringify({
      type: "terminal.output",
      version: 1,
      phase: "delta",
      seqStart: 0,
      seqEnd: payload.length,
      byteLength: payload.length,
    }),
  );
  output.send(payload);
  await page.waitForFunction(
    (hint) =>
      (
        window as unknown as {
          resumeTerminal: {
            buffer: { active: { getLine: (line: number) => { translateToString: () => string } } };
          };
        }
      ).resumeTerminal.buffer.active
        .getLine(2)
        .translateToString()
        .includes(hint.slice(0, 24)),
    hint,
  );
  const rect = (await page.locator("#terminal .xterm-screen").boundingBox())!;
  const geometry = await page.evaluate(() => {
    const terminal = (window as unknown as { resumeTerminal: { cols: number; rows: number } })
      .resumeTerminal;
    return { cols: terminal.cols, rows: terminal.rows };
  });
  await page.touchscreen.tap(
    rect.x + (3.5 * rect.width) / geometry.cols,
    rect.y + (2.5 * rect.height) / geometry.rows,
  );
}

// The Remote keeps the navigation snapshot it loaded while the agent ran;
// only the open drawer polls it. The hint an agent leaves after Ctrl+C must
// be judged by the host's current state, not by that stale snapshot.
test("a hint left after the agent exits resumes although the loaded snapshot still shows the agent", async ({
  page,
}) => {
  const host = { activity: { type: "interactiveApp", name: "Claude" }, commandRunning: true };
  const { output, submissions } = await openResumeRemote(page, host);
  const id = "11111111-2222-4333-8444-555555555555";

  // The agent exits with Ctrl+C; the drawer stays closed, so nothing reloads.
  host.activity = { type: "shell" };
  host.commandRunning = false;
  await showResumeHintAndTap(page, output, `claude --resume ${id}`);

  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toEqual({
    leaseId: "lease-1",
    text: `claude --dangerously-skip-permissions --resume ${id}`,
    submit: true,
  });
});

test("a hint tapped while the host still runs the agent is not typed into it", async ({ page }) => {
  const host = { activity: { type: "interactiveApp", name: "Claude" }, commandRunning: true };
  const { output, submissions, navigationReads } = await openResumeRemote(page, host);
  const readsBeforeTap = navigationReads.count;
  await showResumeHintAndTap(page, output, "claude --resume 11111111-2222-4333-8444-555555555555");

  // The tap reached the link and asked the host, which refused it.
  await expect.poll(() => navigationReads.count).toBeGreaterThan(readsBeforeTap);
  await page.waitForTimeout(300);
  expect(submissions).toEqual([]);
});
