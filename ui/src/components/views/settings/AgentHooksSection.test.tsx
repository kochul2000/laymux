import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooksSection } from "./AgentHooksSection";
import { refreshAgentHookUpdates, useAgentHookUpdateStore } from "@/lib/agent-hook-updates";

const invoke = vi.hoisted(() => vi.fn());
const checkInstallation = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/agent-hooks-api", async (original) => ({
  ...(await original<typeof import("@/lib/agent-hooks-api")>()),
  checkAgentHookInstallation: checkInstallation,
}));

describe("AgentHooksSection", () => {
  it("Grok도 전용 provider로 조회하고 훅 감지 모드를 선택한다", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments")
        return [{ id: "native", label: "Windows", distro: null }];
      if (command === "get_agent_hook_connections") return [];
      return {
        configDir: "C:/Users/u/.grok",
        configPath: "C:/Users/u/.grok/hooks/laymux.json",
        installed: false,
        registered: 0,
        expected: 12,
        helperPresent: false,
        disabled: false,
      };
    });
    const changed = vi.fn();
    render(<AgentHooksSection provider="grok" onStateDetectionChange={changed} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "manage_agent_hooks",
        expect.objectContaining({
          request: expect.objectContaining({ provider: "grok", operation: "status" }),
        }),
      ),
    );
    fireEvent.change(screen.getByTestId("agent-hooks-detection"), { target: { value: "hooks" } });
    expect(changed).toHaveBeenCalledWith("hooks");
  });
  it("serializes a Settings update after a pending audit and publishes a new audit", async () => {
    const stale = {
      configDir: "/custom",
      configPath: "/custom/hooks.json",
      installed: true,
      registered: 10,
      expected: 10,
      helperPresent: true,
      disabled: false,
      updateRequired: true,
    };
    let resolve!: (value: unknown) => void;
    let reads = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === "get_agent_hook_updates") {
        if (reads++ === 0)
          return new Promise((done) => {
            resolve = done;
          });
        return {
          targets: [
            { provider: "codex", distro: null, status: { ...stale, updateRequired: false } },
          ],
          errors: [],
        };
      }
      if (command === "manage_agent_hooks")
        return { ...stale, updateRequired: args.request.operation !== "update" };
      return [];
    });
    const audit = refreshAgentHookUpdates();
    render(<AgentHooksSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-hooks-install")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-hooks-install"));
    const prematureWrites = invoke.mock.calls.filter(
      ([, args]) => args?.request?.operation === "update",
    );
    // Always release the read so a failing regression does not leave the queue stuck.
    await act(async () => {
      resolve({ targets: [{ provider: "codex", distro: null, status: stale }], errors: [] });
      await audit;
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(prematureWrites).toHaveLength(0);
    await waitFor(() =>
      expect(useAgentHookUpdateStore.getState().targets[0].status.updateRequired).toBe(false),
    );
  });
  beforeEach(() => {
    checkInstallation.mockReset().mockResolvedValue({ status: "installed" });
    invoke.mockReset();
    invoke.mockImplementation(async (command, args) => {
      if (command === "list_agent_hook_environments")
        return [
          { id: "native", label: "Windows", distro: null },
          { id: "wsl:Ubuntu", label: "WSL · Ubuntu", distro: "Ubuntu" },
        ];
      if (command === "get_agent_hook_connections") return [];
      if (command === "get_agent_hook_updates") return { targets: [], errors: [] };
      return {
        configDir: args.request.distro ? "/home/me/.codex" : "C:/Users/me/.codex",
        configPath: "hooks.json",
        installed: args.request.operation === "install",
        registered: args.request.operation === "install" ? 10 : 0,
        expected: 10,
        helperPresent: args.request.operation === "install",
        disabled: false,
      };
    });
  });

  it.each(["claude", "codex"] as const)(
    "%s 미설치를 훅 미설치와 구분하고 설치 후 재확인한다",
    async (provider) => {
      checkInstallation.mockResolvedValue({ status: "missing" });
      render(<AgentHooksSection provider={provider} />);
      const name = provider === "claude" ? "Claude Code" : "Codex";
      expect(
        await screen.findByText(`${name} is not installed in this environment`),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Install the agent in the selected environment, then check again."),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("agent-hooks-install-summary")).not.toBeInTheDocument();
      expect(screen.getByTestId("agent-hooks-install")).toBeDisabled();
      expect(invoke.mock.calls.some(([command]) => command === "manage_agent_hooks")).toBe(false);
      checkInstallation.mockResolvedValue({ status: "installed" });
      fireEvent.click(screen.getByTestId("agent-hooks-refresh"));
      await waitFor(() => expect(screen.getByTestId("agent-hooks-install")).toBeEnabled());
    },
  );

  it("docker-desktop에서 조회 실패를 에이전트 미설치로 추측하지 않는다", async () => {
    checkInstallation.mockImplementation(async (_provider, distro) =>
      distro ? { status: "unknown", detail: "WSL failed (exit code: 1)" } : { status: "installed" },
    );
    invoke.mockImplementation(async (command) =>
      command === "list_agent_hook_environments"
        ? [
            { id: "native", label: "Windows", distro: null },
            { id: "wsl:docker-desktop", label: "WSL · docker-desktop", distro: "docker-desktop" },
          ]
        : [],
    );
    render(<AgentHooksSection provider="codex" />);
    await screen.findByRole("option", { name: "WSL · docker-desktop" });
    fireEvent.change(screen.getByTestId("agent-hooks-environment"), {
      target: { value: "wsl:docker-desktop" },
    });
    expect(
      await screen.findByText("Could not determine whether Codex is installed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("WSL failed (exit code: 1)");
    expect(
      screen.queryByText("Codex is not installed in this environment"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-hooks-install")).toBeDisabled();
  });

  it("설치 조회 요청이 거부되면 확인 불가를 표시한다", async () => {
    checkInstallation.mockRejectedValue(new Error("permission denied"));
    render(<AgentHooksSection provider="claude" />);
    expect(
      await screen.findByText("Could not determine whether Claude Code is installed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.getByTestId("agent-hooks-install")).toBeDisabled();
  });

  it("이전 환경에서 늦게 도착한 미설치 응답을 폐기한다", async () => {
    let resolve!: (value: { status: string }) => void;
    checkInstallation.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<AgentHooksSection provider="codex" />);
    await waitFor(() => expect(checkInstallation).toHaveBeenCalledWith("codex", null));
    fireEvent.change(screen.getByTestId("agent-hooks-environment"), {
      target: { value: "wsl:Ubuntu" },
    });
    await waitFor(() => expect(screen.getByTestId("agent-hooks-install")).toBeEnabled());
    await act(async () => {
      resolve({ status: "missing" });
    });
    expect(screen.getByTestId("agent-hooks-install")).toBeEnabled();
    expect(
      screen.queryByText("Codex is not installed in this environment"),
    ).not.toBeInTheDocument();
  });

  it("warns when installed hooks need an update instead of claiming they are current", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments" || command === "get_agent_hook_connections")
        return [];
      return {
        configDir: "/custom",
        configPath: "/custom/hooks.json",
        installed: true,
        registered: 10,
        currentRegistered: 10,
        expected: 10,
        helperPresent: true,
        helperCurrent: false,
        disabled: false,
        updateRequired: true,
        updateReasons: ["helper_outdated"],
      };
    });
    render(<AgentHooksSection provider="codex" />);
    expect(await screen.findByTestId("agent-hooks-update-needed")).toHaveTextContent("update");
    expect(screen.getByTestId("agent-hooks-install")).toHaveTextContent("Update hooks");
    fireEvent.click(screen.getByTestId("agent-hooks-install"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_hooks", {
        request: { provider: "codex", operation: "update", distro: null, configDir: null },
      }),
    );
  });

  it("previews added hooks before installation and explains reinstall without duplicates", async () => {
    render(<AgentHooksSection provider="codex" />);
    expect(await screen.findByTestId("agent-hooks-install-summary")).toHaveTextContent(
      "10 hooks will be added",
    );
    fireEvent.click(screen.getByTestId("agent-hooks-install"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-hooks-install-summary")).toHaveTextContent(
        "10 hooks will be updated",
      ),
    );
    expect(screen.getByTestId("agent-hooks-install-summary")).toHaveTextContent(
      "without duplicates",
    );
  });

  it("uses backend counts for a partial installation", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments" || command === "get_agent_hook_connections")
        return [];
      return {
        configDir: "/config",
        configPath: "/config/settings.json",
        installed: false,
        registered: 9,
        expected: 14,
        helperPresent: true,
        disabled: false,
      };
    });
    render(<AgentHooksSection provider="claude" />);
    expect(await screen.findByTestId("agent-hooks-install-summary")).toHaveTextContent(
      "5 missing hooks will be added",
    );
    expect(screen.getByTestId("agent-hooks-install-summary")).toHaveTextContent("14 total");
  });

  it("does not install on mount and installs only the selected environment", async () => {
    render(<AgentHooksSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-hooks-install")).toBeEnabled());
    expect(
      invoke.mock.calls.filter(([, args]) => args?.request?.operation === "install"),
    ).toHaveLength(0);
    fireEvent.change(screen.getByTestId("agent-hooks-environment"), {
      target: { value: "wsl:Ubuntu" },
    });
    await waitFor(() => expect(screen.getByTestId("agent-hooks-install")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-hooks-install"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_hooks", {
        request: { provider: "codex", operation: "install", distro: "Ubuntu", configDir: null },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("agent-hooks-remove")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-hooks-remove"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_hooks", {
        request: { provider: "codex", operation: "remove", distro: "Ubuntu", configDir: null },
      }),
    );
  });

  it("reports invalid settings without offering an overwrite", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments") return [];
      if (command === "get_agent_hook_connections") return [];
      throw new Error("Invalid hook settings");
    });
    render(<AgentHooksSection provider="claude" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid hook settings");
    expect(screen.getByTestId("agent-hooks-install")).toBeDisabled();
  });

  it("shows title binding status and permits cleanup after hooks were removed separately", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments" || command === "get_agent_hook_connections")
        return [];
      return {
        configDir: "C:/Users/me/.codex",
        configPath: "hooks.json",
        installed: false,
        registered: 0,
        expected: 10,
        helperPresent: false,
        disabled: false,
        titleBinding: { configured: false, managed: true, warning: "User-edited title retained" },
      };
    });
    render(<AgentHooksSection provider="codex" stateDetection="hooks" />);
    expect(await screen.findByTestId("agent-hooks-title-status")).toBeInTheDocument();
    expect(screen.getByText("User-edited title retained")).toBeInTheDocument();
    expect(screen.getByTestId("agent-hooks-remove")).toBeEnabled();
  });
});
