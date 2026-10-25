import { test as base, expect } from "./fixtures";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

// Dev console/health traffic continues after hydration; wait for the UI itself.
const test = base.extend({
  appPage: async ({ page }, use) => {
    await page.addInitScript(TAURI_MOCK_SCRIPT);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-root")).toBeVisible();
    await use(page);
  },
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: native/WSL에서 에이전트·훅 미설치와 확인 불가를 구분한다`, async ({
    appPage: page,
  }) => {
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "list_agent_hook_environments")
          return [
            { id: "native", label: "Windows", distro: null },
            { id: "wsl:Ubuntu", label: "WSL · Ubuntu", distro: "Ubuntu" },
            { id: "wsl:docker-desktop", label: "WSL · docker-desktop", distro: "docker-desktop" },
          ];
        if (command === "manage_agent_hooks") {
          const request = (args as { request: { operation: string; distro: string | null } })
            .request;
          const scenario = (window as unknown as { hookScenario?: string }).hookScenario;
          if (request.operation === "agent-status")
            return {
              status:
                scenario === "missing"
                  ? "missing"
                  : scenario === "unknown"
                    ? "unknown"
                    : "installed",
              detail: scenario === "unknown" ? "WSL failed (exit code: 1)" : undefined,
            };
          if (scenario === "hook-error") throw new Error("WSL helper failed (exit code: 1)");
          return {
            configDir: "/config",
            configPath: "/config/hooks.json",
            installed: scenario === "installed",
            registered: scenario === "installed" ? 10 : 0,
            expected: 10,
            helperPresent: scenario === "installed",
            disabled: false,
          };
        }
        return original(command, args);
      };
    });
    await page.keyboard.press("Control+,");
    await page.getByTestId(`nav-${provider}`).click();
    const name = provider === "claude" ? "Claude Code" : "Codex";
    for (const environment of ["native", "wsl:Ubuntu", "wsl:docker-desktop"]) {
      await page.getByTestId("agent-hooks-environment").selectOption(environment);
      for (const scenario of ["missing", "unknown", "installed", "hooks-missing", "hook-error"]) {
        await page.evaluate((value) => {
          (window as unknown as { hookScenario: string }).hookScenario = value;
        }, scenario);
        await page.getByTestId("agent-hooks-refresh").click();
        const summary = page.getByTestId("agent-hooks-status");
        if (scenario === "missing") {
          await expect(summary).toContainText(`${name} is not installed in this environment`);
          await expect(page.getByTestId("agent-hooks-install")).toBeDisabled();
        } else if (scenario === "unknown") {
          await expect(summary).toContainText(`Could not determine whether ${name} is installed`);
          await expect(summary).not.toContainText(`${name} is not installed`);
          await expect(page.getByTestId("agent-hooks-install")).toBeDisabled();
        } else if (scenario === "hook-error") {
          await expect(summary).toContainText("WSL helper failed (exit code: 1)");
          await expect(summary).not.toContainText(`${name} is not installed`);
          await expect(page.getByTestId("agent-hooks-install")).toBeDisabled();
        } else {
          await expect(page.getByTestId("agent-hooks-install")).toBeEnabled();
          await expect(page.getByTestId("agent-hooks-install-summary")).toContainText(
            scenario === "installed" ? "updated without duplicates" : "hooks will be added",
          );
        }
      }
    }
  });
}

test("agent hooks are explicit and isolated by provider and WSL environment", async ({
  appPage: page,
}) => {
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      hookWrites: unknown[];
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    const installed = new Set<string>();
    host.hookWrites = [];
    host.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "list_agent_hook_environments")
        return [
          { id: "native", label: "Windows", distro: null },
          { id: "wsl:Ubuntu", label: "WSL · Ubuntu", distro: "Ubuntu" },
        ];
      if (command === "get_agent_hook_connections") return [];
      if (command === "manage_agent_hooks") {
        const request = args?.request as {
          provider: string;
          operation: string;
          distro: string | null;
          configDir: string | null;
        };
        const key = JSON.stringify([request.provider, request.distro, request.configDir]);
        if (request.operation === "agent-status") return { status: "installed" };
        if (request.operation !== "status") host.hookWrites.push(request);
        if (request.operation === "install") installed.add(key);
        if (request.operation === "remove") installed.delete(key);
        return {
          configDir: "/config",
          configPath: "/config/hooks.json",
          installed: installed.has(key),
          registered: installed.has(key) ? (request.provider === "codex" ? 10 : 14) : 0,
          expected: request.provider === "codex" ? 10 : 14,
          helperPresent: installed.has(key),
          disabled: false,
          titleBinding:
            request.provider === "codex"
              ? { configured: installed.has(key), managed: installed.has(key), warning: null }
              : null,
        };
      }
      return original(command, args);
    };
  });
  await page.keyboard.press("Control+,");
  await page.getByTestId("nav-codex").click();
  await expect(page.getByTestId("agent-hooks-install")).toBeEnabled();
  await expect(page.getByTestId("agent-hooks-install-summary")).toContainText(
    "10 hooks will be added",
  );
  await expect(page.getByTestId("agent-hooks-details")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("agent-hooks-detection")).toHaveValue("heuristic");
  await page.getByTestId("agent-hooks-detection").selectOption("hooks");
  expect(
    await page.evaluate(() => (window as unknown as { hookWrites: unknown[] }).hookWrites),
  ).toEqual([]);
  await page.getByTestId("agent-hooks-environment").selectOption("wsl:Ubuntu");
  await page.getByTestId("agent-hooks-install").click();
  await expect(page.getByTestId("agent-hooks-remove")).toBeEnabled();
  await expect(page.getByTestId("agent-hooks-install-summary")).toContainText(
    "10 hooks will be updated without duplicates",
  );
  await expect(page.getByTestId("agent-hooks-title-status")).toContainText("configured");
  await page.getByTestId("agent-hooks-environment").selectOption("native");
  await expect(page.getByTestId("agent-hooks-install")).toBeEnabled();
  await expect(page.getByTestId("agent-hooks-remove")).toBeDisabled();
  await expect(page.getByTestId("agent-hooks-title-status")).toContainText("not configured");
  await page.getByTestId("nav-claude").click();
  await expect(page.getByTestId("agent-hooks-title-status")).toHaveCount(0);
  await expect(page.getByTestId("agent-hooks-install-summary")).toContainText(
    "14 hooks will be added",
  );
  await expect(page.getByTestId("agent-hooks-detection")).toHaveValue("heuristic");
  await expect(page.getByTestId("agent-hooks-install")).toBeEnabled();
  await expect(page.getByTestId("agent-hooks-remove")).toBeDisabled();
  await page.getByTestId("nav-codex").click();
  await expect(page.getByTestId("agent-hooks-detection")).toHaveValue("hooks");
  await page.getByTestId("agent-hooks-environment").selectOption("wsl:Ubuntu");
  await page.getByTestId("agent-hooks-remove").click();
  await expect(page.getByTestId("agent-hooks-remove")).toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as { hookWrites: unknown[] }).hookWrites),
  ).toEqual([
    { provider: "codex", operation: "install", distro: "Ubuntu", configDir: null },
    { provider: "codex", operation: "remove", distro: "Ubuntu", configDir: null },
  ]);
  await page.getByTestId("save-settings-btn").click();
  await page.keyboard.press("Control+,");
  await page.keyboard.press("Control+,");
  await page.getByTestId("nav-codex").click();
  await expect(page.getByTestId("agent-hooks-detection")).toHaveValue("hooks");
});
