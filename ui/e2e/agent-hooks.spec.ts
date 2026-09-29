import { test, expect } from "./fixtures";

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
