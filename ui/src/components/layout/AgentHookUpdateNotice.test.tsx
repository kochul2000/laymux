import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHookUpdateNotice } from "./AgentHookUpdateNotice";
import { useAgentHookUpdateStore, refreshAgentHookUpdates } from "@/lib/agent-hook-updates";
import { useSettingsStore } from "@/stores/settings-store";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const persistSession = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/persist-session", () => ({ persistSession }));
const missing = { provider: "codex", distro: "Ubuntu", hook: true, mcp: false };
const target = {
  provider: "codex",
  distro: "Ubuntu",
  status: {
    configDir: "/custom/.codex",
    configPath: "/custom/.codex/hooks.json",
    installed: true,
    registered: 10,
    currentRegistered: 10,
    expected: 10,
    helperPresent: true,
    helperCurrent: false,
    disabled: false,
    updateRequired: true,
    updateReasons: ["helper_outdated"],
  },
};

describe("AgentHookUpdateNotice", () => {
  beforeEach(() => {
    useAgentHookUpdateStore.setState({
      targets: [],
      errors: [],
      missing: [],
      dismissed: [],
      busyKey: null,
    });
    useSettingsStore.setState((s) => ({
      notifications: { ...s.notifications, agentIntegrationMissing: true },
    }));
    invoke.mockReset();
    persistSession.mockClear();
  });
  it("notifies outside Settings and updates only the selected WSL custom folder", async () => {
    invoke.mockImplementation(async (command) =>
      command === "get_agent_hook_updates"
        ? { targets: [target], errors: [] }
        : { ...target.status, helperCurrent: true, updateRequired: false },
    );
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates());
    expect(screen.getByTestId("agent-hook-update-notice")).toHaveTextContent("Ubuntu");
    expect(invoke.mock.calls.filter(([c]) => c === "manage_agent_hooks")).toHaveLength(0);
    invoke.mockImplementation(async (command) =>
      command === "get_agent_hook_updates"
        ? { targets: [], errors: [] }
        : { ...target.status, helperCurrent: true, updateRequired: false },
    );
    fireEvent.click(screen.getByTestId("agent-hook-update-action"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_hooks", {
        request: {
          provider: "codex",
          operation: "update",
          distro: "Ubuntu",
          configDir: "/custom/.codex",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("agent-hook-update-notice")).not.toBeInTheDocument(),
    );
  });
  it("retains update failures and permits retry without silently installing", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "get_agent_hook_updates") return { targets: [target], errors: [] };
      throw new Error("helper is locked");
    });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates());
    fireEvent.click(screen.getByTestId("agent-hook-update-action"));
    expect(await screen.findByText(/helper is locked/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("agent-hook-update-action")).toBeEnabled());
  });
  it("lets users dismiss the notice without installing or hiding Settings state", async () => {
    invoke.mockResolvedValue({ targets: [target], errors: [] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates());
    fireEvent.click(screen.getByTestId("agent-hook-update-dismiss"));
    expect(screen.queryByTestId("agent-hook-update-notice")).not.toBeInTheDocument();
    expect(useAgentHookUpdateStore.getState().targets).toHaveLength(1);
    expect(invoke.mock.calls.filter(([c]) => c === "manage_agent_hooks")).toHaveLength(0);
  });
  it("keeps a dismissed environment error hidden when the next timeout has different text", async () => {
    const error = {
      provider: "codex",
      distro: "Ubuntu",
      configDir: "/custom/.codex",
      message: "process timed out after 8s",
    };
    invoke.mockResolvedValue({ targets: [], errors: [error] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates());
    fireEvent.click(screen.getByTestId("agent-hook-update-dismiss"));
    invoke.mockResolvedValue({
      targets: [],
      errors: [{ ...error, message: "process timed out after 3s" }],
    });
    await act(() => refreshAgentHookUpdates());
    expect(screen.queryByTestId("agent-hook-update-notice")).not.toBeInTheDocument();
    expect(useAgentHookUpdateStore.getState().errors[0].message).toBe("process timed out after 3s");
  });
  it("still displays errors from a different environment after dismissing the first", async () => {
    const error = {
      provider: "codex",
      distro: "Ubuntu",
      configDir: "/custom/.codex",
      message: "timeout",
    };
    invoke.mockResolvedValue({ targets: [], errors: [error] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates());
    fireEvent.click(screen.getByTestId("agent-hook-update-dismiss"));
    invoke.mockResolvedValue({
      targets: [],
      errors: [error, { ...error, distro: "Debian", message: "Debian failed" }],
    });
    await act(() => refreshAgentHookUpdates());
    expect(screen.getByTestId("agent-hook-update-notice")).toHaveTextContent("Debian failed");
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
  });
  it("offers only the missing integration of a used environment and installs on click", async () => {
    invoke.mockResolvedValue({ targets: [], errors: [], missing: [missing] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates(true));
    const row = screen.getByTestId("agent-integration-missing");
    expect(row).toHaveTextContent("Codex");
    expect(row).toHaveTextContent("Ubuntu");
    expect(screen.queryByTestId("agent-integration-install-mcp")).not.toBeInTheDocument();
    expect(invoke.mock.calls.filter(([c]) => c === "manage_agent_hooks")).toHaveLength(0);
    invoke.mockImplementation(async (command) =>
      command === "get_agent_hook_updates"
        ? { targets: [], errors: [], missing: [] }
        : { ...target.status },
    );
    fireEvent.click(screen.getByTestId("agent-integration-install-hook"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("manage_agent_hooks", {
        request: { provider: "codex", operation: "install", distro: "Ubuntu", configDir: null },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("agent-hook-update-notice")).not.toBeInTheDocument(),
    );
  });
  it("turns the missing notice off when dismissed with don't show again", async () => {
    invoke.mockResolvedValue({ targets: [target], errors: [], missing: [missing] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates(true));
    fireEvent.click(screen.getByTestId("agent-integration-never-show"));
    fireEvent.click(screen.getByTestId("agent-hook-update-dismiss"));
    expect(useSettingsStore.getState().notifications.agentIntegrationMissing).toBe(false);
    expect(persistSession).toHaveBeenCalledTimes(1);
    // Update notices are not governed by the switch: a new run still shows them.
    act(() => useAgentHookUpdateStore.setState({ dismissed: [] }));
    expect(screen.getByTestId("agent-hook-update-notice")).toHaveTextContent("Ubuntu");
    expect(screen.queryByTestId("agent-integration-missing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-integration-never-show")).not.toBeInTheDocument();
  });
  it("hides only the current run's rows when dismissed without the checkbox", async () => {
    invoke.mockResolvedValue({ targets: [], errors: [], missing: [missing] });
    render(<AgentHookUpdateNotice />);
    await act(() => refreshAgentHookUpdates(true));
    fireEvent.click(screen.getByTestId("agent-hook-update-dismiss"));
    expect(screen.queryByTestId("agent-hook-update-notice")).not.toBeInTheDocument();
    expect(useSettingsStore.getState().notifications.agentIntegrationMissing).toBe(true);
    expect(persistSession).not.toHaveBeenCalled();
  });
});
