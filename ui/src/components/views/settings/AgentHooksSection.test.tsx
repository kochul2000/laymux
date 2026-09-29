import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooksSection } from "./AgentHooksSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("AgentHooksSection", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command, args) => {
      if (command === "list_agent_hook_environments")
        return [
          { id: "native", label: "Windows", distro: null },
          { id: "wsl:Ubuntu", label: "WSL · Ubuntu", distro: "Ubuntu" },
        ];
      if (command === "get_agent_hook_connections") return [];
      return {
        configDir: args.request.distro ? "/home/me/.codex" : "C:/Users/me/.codex",
        configPath: "hooks.json",
        installed: args.request.operation === "install",
        registered: args.request.operation === "install" ? 2 : 0,
        expected: 2,
        helperPresent: args.request.operation === "install",
        disabled: false,
      };
    });
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
});
