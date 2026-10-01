import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHookUpdateNotice } from "./AgentHookUpdateNotice";
import { useAgentHookUpdateStore, refreshAgentHookUpdates } from "@/lib/agent-hook-updates";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
    useAgentHookUpdateStore.setState({ targets: [], errors: [], dismissed: [], busyKey: null });
    invoke.mockReset();
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
});
