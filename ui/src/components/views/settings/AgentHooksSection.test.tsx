import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooksSection } from "./AgentHooksSection";
import { refreshAgentHookUpdates, useAgentHookUpdateStore } from "@/lib/agent-hook-updates";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("AgentHooksSection", () => {
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
