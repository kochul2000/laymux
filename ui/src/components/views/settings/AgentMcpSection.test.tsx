import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMcpSection } from "./AgentMcpSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const URL = "http://127.0.0.1:19280/mcp";
const base = {
  provider: "codex",
  configPath: "C:/Users/me/.codex/config.toml",
  name: "laymux",
  url: URL,
  currentUrl: null,
  state: "missing",
  installed: false,
  disabled: false,
  reachable: true,
};

describe("AgentMcpSection", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  function mockStatus(status: (request: { operation: string; distro: string | null }) => object) {
    invoke.mockImplementation(async (command, args) => {
      if (command === "list_agent_hook_environments")
        return [
          { id: "native", label: "Windows", distro: null },
          { id: "wsl:Ubuntu", label: "WSL · Ubuntu", distro: "Ubuntu" },
        ];
      if (command === "manage_agent_mcp") return { ...base, ...status(args.request) };
      throw new Error(`unexpected ${command}`);
    });
  }

  it("registers in one click and then offers only removal", async () => {
    mockStatus(({ operation }) =>
      operation === "install"
        ? { state: "installed", installed: true, currentUrl: URL }
        : { state: "missing" },
    );
    render(<AgentMcpSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    expect(screen.getByTestId("agent-mcp-remove")).toBeDisabled();
    expect(screen.getByTestId("agent-mcp-plan").textContent).toContain(URL);

    fireEvent.click(screen.getByTestId("agent-mcp-install"));
    await waitFor(() => expect(screen.getByTestId("agent-mcp-remove")).toBeEnabled());
    expect(screen.getByTestId("agent-mcp-install")).toBeDisabled();
    expect(invoke).toHaveBeenCalledWith("manage_agent_mcp", {
      request: {
        provider: "codex",
        operation: "install",
        distro: null,
        configDir: null,
        cached: false,
      },
    });
  });

  it("checks each WSL distribution separately and blocks unreachable registration", async () => {
    mockStatus(({ distro }) =>
      distro
        ? {
            url: null,
            reachable: false,
            state: "unverified",
            currentUrl: "http://172.20.0.1:19280/mcp",
          }
        : { state: "missing" },
    );
    render(<AgentMcpSection provider="grok" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    fireEvent.change(screen.getByTestId("agent-mcp-environment"), {
      target: { value: "wsl:Ubuntu" },
    });
    await waitFor(() => expect(screen.getByTestId("agent-mcp-current")).toBeInTheDocument());
    expect(screen.getByTestId("agent-mcp-status").textContent).toContain("address not verifiable");
    expect(screen.getByTestId("agent-mcp-install")).toBeDisabled();
    expect(screen.getByTestId("agent-mcp-remove")).toBeEnabled();
    expect(invoke).toHaveBeenCalledWith("manage_agent_mcp", {
      request: {
        provider: "grok",
        operation: "status",
        distro: "Ubuntu",
        configDir: null,
        cached: true,
      },
    });
  });

  it("shows backend failures instead of a stale status", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_agent_hook_environments") return [];
      throw "Invalid config.toml: broken";
    });
    render(<AgentMcpSection provider="claude" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Invalid config"));
    expect(screen.getByTestId("agent-mcp-install")).toBeDisabled();
  });

  it("keeps the last status when a change fails so the user can retry or remove", async () => {
    mockStatus(({ operation }) => {
      if (operation === "install") throw "Agent settings changed concurrently; retry";
      return { state: "different", currentUrl: "http://old/mcp" };
    });
    render(<AgentMcpSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    fireEvent.click(screen.getByTestId("agent-mcp-install"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("concurrently"));
    expect(screen.getByTestId("agent-mcp-install")).toBeEnabled();
    expect(screen.getByTestId("agent-mcp-remove")).toBeEnabled();
    expect(screen.getByTestId("agent-mcp-status").textContent).toContain("Update needed");
  });

  it("targets a custom configuration folder", async () => {
    mockStatus(() => ({ state: "missing" }));
    render(<AgentMcpSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    fireEvent.change(screen.getByTestId("agent-mcp-config-dir"), {
      target: { value: "/home/me/.codex-work" },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_mcp", {
        request: {
          provider: "codex",
          operation: "status",
          distro: null,
          configDir: "/home/me/.codex-work",
          cached: true,
        },
      }),
    );
  });

  it("explains a same-address repair instead of claiming another address", async () => {
    mockStatus(() => ({ state: "different", currentUrl: URL }));
    render(<AgentMcpSection provider="codex" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    expect(screen.getByTestId("agent-mcp-plan").textContent).toContain(
      "do not fit an HTTP connection",
    );
    expect(screen.queryByTestId("agent-mcp-current")).toBeNull();
  });

  it("reads the startup check on open and re-reads the CLI only on explicit refresh", async () => {
    mockStatus(() => ({ state: "missing" }));
    render(<AgentMcpSection provider="claude" />);
    await waitFor(() => expect(screen.getByTestId("agent-mcp-install")).toBeEnabled());
    const statusCalls = () =>
      invoke.mock.calls
        .filter(([command]) => command === "manage_agent_mcp")
        .map(([, args]) => args.request.cached);
    expect(statusCalls()).toEqual([true]);
    fireEvent.click(screen.getByTestId("agent-mcp-refresh"));
    await waitFor(() => expect(statusCalls()).toEqual([true, false]));
  });
});
