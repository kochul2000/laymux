import { test as base, expect, type Page } from "@playwright/test";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

type AgentCheck = {
  status: "installed" | "missing" | "unknown";
  environment: "windows" | "wsl" | "linux" | "unknown";
  version?: string;
  detail?: string;
  effectiveCommand?: string;
};
type Call = { cmd: string; args: Record<string, unknown> };

type MockWindow = Window & {
  __agentChecks: Array<AgentCheck | { error: string } | { deferred: true }>;
  __agentCalls: Call[];
  __resolveAgentCheck: (result: AgentCheck) => void;
};

const AGENT_MOCK_SCRIPT = `${TAURI_MOCK_SCRIPT}
(function() {
  var original = window.__TAURI_INTERNALS__.invoke;
  var pending = null;
  window.__agentChecks = [];
  window.__agentCalls = [];
  window.__resolveAgentCheck = function(result) {
    if (!pending) throw new Error('No pending agent check');
    pending(result);
    pending = null;
  };
  window.__TAURI_INTERNALS__.invoke = function(cmd, args, options) {
    window.__agentCalls.push({ cmd: cmd, args: args || {} });
    if (cmd === 'check_agent_installation') {
      var next = window.__agentChecks.shift();
      if (!next) throw new Error('Unexpected agent installation check');
      if (next.deferred) return new Promise(function(resolve) { pending = resolve; });
      if (next.error) return Promise.reject(next.error);
      return Promise.resolve(next);
    }
    return original(cmd, args, options);
  };
})();`;

const test = base.extend<{ appPage: Page }>({
  appPage: async ({ page }, use) => {
    await page.addInitScript(AGENT_MOCK_SCRIPT);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByTestId("app-root")).toBeVisible();
    await use(page);
  },
});

async function queueCheck(page: Page, result: AgentCheck | { error: string } | { deferred: true }) {
  await page.evaluate((value) => (window as MockWindow).__agentChecks.push(value), result);
}

async function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (name) => (window as MockWindow).__agentCalls.filter((call) => call.cmd === name),
    cmd,
  );
}

async function openSetup(page: Page) {
  await page.getByTestId("agent-setup-entry").click();
  await expect(page.getByTestId("agent-setup-page")).toBeVisible();
}

test("첫 로드에서는 연결 안내와 진단을 자동 실행하지 않고 명시적으로 진입한다", async ({
  appPage: page,
}) => {
  await expect(page.getByTestId("agent-setup-page")).toHaveCount(0);
  expect(await calls(page, "check_agent_installation")).toHaveLength(0);
  expect((await calls(page, "create_terminal_session")).length).toBeGreaterThan(0);
  expect(
    (await calls(page, "create_terminal_session")).every(
      (call) => call.args.agentStartup === null && call.args.shellOnlyStartup === false,
    ),
  ).toBe(true);
  await openSetup(page);
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
  await page.getByTestId("nav-claude").click();
  await expect(page.getByTestId("agent-setup-page")).toHaveCount(0);
  await page.getByTestId("nav-agentSetup").click();
  await expect(page.getByTestId("agent-setup-page")).toBeVisible();
  expect(await calls(page, "check_agent_installation")).toHaveLength(0);
  expect(await calls(page, "save_settings")).toHaveLength(0);
});

test("설치 확인 후 선택한 에이전트를 새 pane에서 구조화 요청으로 시작한다", async ({
  appPage: page,
}) => {
  await openSetup(page);
  await page.getByTestId("agent-setup-agent").selectOption("codex");
  await page.getByTestId("agent-setup-profile").selectOption("WSL");
  await queueCheck(page, {
    status: "installed",
    environment: "wsl",
    version: "codex 1.2.3",
    effectiveCommand: "codex --model test",
  });
  await page.getByTestId("agent-setup-check").click();
  await expect(page.getByTestId("agent-setup-installed")).toContainText("codex 1.2.3");
  await expect(page.getByTestId("agent-setup-command")).toHaveText("codex --model test");
  expect(await calls(page, "check_agent_installation")).toEqual([
    { cmd: "check_agent_installation", args: { agentId: "codex", profileName: "WSL" } },
  ]);

  const before = await calls(page, "create_terminal_session");
  await page.getByTestId("agent-setup-launch").click();
  await expect
    .poll(async () =>
      (await calls(page, "create_terminal_session")).some(
        (call) =>
          call.args.agentStartup &&
          (call.args.agentStartup as { agentId: string }).agentId === "codex",
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("workspace-pane-0")).toBeAttached();
  await expect(page.getByTestId("workspace-pane-1")).toBeAttached();
  const after = await calls(page, "create_terminal_session");
  expect(after[0].args.id).toBe(before[0].args.id);
  const launched = after.find(
    (call) => (call.args.agentStartup as { agentId?: string } | null)?.agentId === "codex",
  )!;
  expect(launched.args).toMatchObject({
    profile: "WSL",
    agentStartup: { agentId: "codex" },
    shellOnlyStartup: false,
    startupCommandOverride: null,
  });
  expect(launched.args.id).not.toBe(before[0].args.id);
  expect(await calls(page, "save_settings")).toHaveLength(0);
});

test("미설치 안내에서 공식 명령을 복사하고 시작 명령 없는 새 셸을 연다", async ({
  appPage: page,
}) => {
  await openSetup(page);
  await queueCheck(page, { status: "missing", environment: "windows", effectiveCommand: "claude" });
  await page.getByTestId("agent-setup-check").click();
  await expect(page.getByTestId("agent-setup-install-help")).toBeVisible();
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
  const command = await page.getByTestId("agent-setup-install-command").innerText();
  expect(command).toContain("claude.ai/install.ps1");
  await page.getByTestId("agent-setup-copy-command").click();
  await expect
    .poll(async () => calls(page, "clipboard_write_text"))
    .toEqual([{ cmd: "clipboard_write_text", args: { text: command } }]);

  const count = (await calls(page, "create_terminal_session")).length;
  await page.getByTestId("agent-setup-open-terminal").click();
  await expect
    .poll(async () =>
      (await calls(page, "create_terminal_session")).some(
        (call) => call.args.shellOnlyStartup === true,
      ),
    )
    .toBe(true);
  expect((await calls(page, "create_terminal_session")).length).toBeGreaterThan(count);
  expect(
    (await calls(page, "create_terminal_session")).find(
      (call) => call.args.shellOnlyStartup === true,
    )?.args,
  ).toMatchObject({ shellOnlyStartup: true, agentStartup: null, startupCommandOverride: null });
  expect(await calls(page, "save_settings")).toHaveLength(0);
});

test("불확실한 결과와 진단 실패는 실행을 허용하지 않는다", async ({ appPage: page }) => {
  await openSetup(page);
  await queueCheck(page, { status: "unknown", environment: "unknown", detail: "probe timed out" });
  await page.getByTestId("agent-setup-check").click();
  await expect(page.getByTestId("agent-setup-page")).toContainText("probe timed out");
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
  await queueCheck(page, { error: "probe failed" });
  await page.getByTestId("agent-setup-check").click();
  await expect(page.getByTestId("agent-setup-page").getByRole("alert")).toContainText(
    "probe failed",
  );
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
});

test("선택 변경 뒤 늦게 도착한 검사 결과를 버리고 고급 설정으로 이동한다", async ({
  appPage: page,
}) => {
  await openSetup(page);
  await queueCheck(page, { deferred: true });
  await page.getByTestId("agent-setup-check").click();
  await page.getByTestId("agent-setup-agent").selectOption("grok");
  await page.evaluate(() =>
    (window as MockWindow).__resolveAgentCheck({
      status: "installed",
      environment: "windows",
      version: "stale Claude",
    }),
  );
  await expect(page.getByTestId("agent-setup-check")).toBeEnabled();
  await expect(page.getByTestId("agent-setup-installed")).toHaveCount(0);
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
  await page.getByTestId("agent-setup-advanced").click();
  await expect(page.getByTestId("agent-setup-page")).toHaveCount(0);
  expect(await calls(page, "save_settings")).toHaveLength(0);
});

test("프로필 변경 뒤 이전 프로필의 지연된 설치 결과를 표시하지 않는다", async ({
  appPage: page,
}) => {
  await openSetup(page);
  await queueCheck(page, { deferred: true });
  await page.getByTestId("agent-setup-check").click();
  await page.getByTestId("agent-setup-profile").selectOption("WSL");
  await page.evaluate(() =>
    (window as MockWindow).__resolveAgentCheck({
      status: "installed",
      environment: "windows",
      version: "old profile",
    }),
  );
  await expect(page.getByTestId("agent-setup-check")).toBeEnabled();
  await expect(page.getByTestId("agent-setup-installed")).toHaveCount(0);
  await expect(page.getByTestId("agent-setup-launch")).toBeDisabled();
  expect(await calls(page, "check_agent_installation")).toEqual([
    { cmd: "check_agent_installation", args: { agentId: "claude", profileName: "PowerShell" } },
  ]);
});
