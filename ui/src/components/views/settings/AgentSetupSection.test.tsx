import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));

import { AgentSetupSection } from "./AgentSetupSection";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useGridStore } from "@/stores/grid-store";
import { useAgentStartupStore } from "@/stores/agent-startup-store";

describe("AgentSetupSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useAgentStartupStore.setState(useAgentStartupStore.getInitialState());
    mockInvoke.mockResolvedValue({ status: "installed", version: "1.2.3", environment: "windows" });
  });

  it("checks the selected agent in the selected profile without launching it", async () => {
    const before = useWorkspaceStore
      .getState()
      .getActiveWorkspace()
      ?.panes.map((pane) => pane.id);
    render(<AgentSetupSection onNavigate={vi.fn()} />);
    fireEvent.change(screen.getByTestId("agent-setup-agent"), { target: { value: "codex" } });
    fireEvent.change(screen.getByTestId("agent-setup-profile"), { target: { value: "WSL" } });
    fireEvent.click(screen.getByTestId("agent-setup-check"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("check_agent_installation", {
        agentId: "codex",
        profileName: "WSL",
      }),
    );
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(
      useWorkspaceStore
        .getState()
        .getActiveWorkspace()
        ?.panes.map((pane) => pane.id),
    ).toEqual(before);
  });

  it("shows installation help only for a missing agent and leaves the current pane intact", async () => {
    mockInvoke.mockResolvedValue({ status: "missing", environment: "windows" });
    render(<AgentSetupSection onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-setup-check"));
    await screen.findByTestId("agent-setup-install-help");
    expect(screen.getByTestId("agent-setup-install-command")).toHaveTextContent(
      "claude.ai/install.ps1",
    );
    const original = useWorkspaceStore.getState().getActiveWorkspace()?.panes[0];
    const count = useWorkspaceStore.getState().getActiveWorkspace()!.panes.length;
    fireEvent.click(screen.getByTestId("agent-setup-open-terminal"));
    const panes = useWorkspaceStore.getState().getActiveWorkspace()?.panes;
    expect(panes).toHaveLength(count + 1);
    expect(panes?.[0].id).toBe(original?.id);
    expect(panes?.[1].view).toEqual({ type: "TerminalView", profile: "PowerShell" });
    expect(useAgentStartupStore.getState().requests[panes![1].id]).toBe("shell");
  });

  it("starts an installed agent only on explicit click in a new pane", async () => {
    render(<AgentSetupSection onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-setup-check"));
    await screen.findByTestId("agent-setup-installed");
    act(() => fireEvent.click(screen.getByTestId("agent-setup-launch")));
    const panes = useWorkspaceStore.getState().getActiveWorkspace()?.panes;
    expect(panes).toHaveLength(3);
    expect(useAgentStartupStore.getState().requests[panes![1].id]).toBe("claude");
  });

  it("hides a stale installation response after the target changes", async () => {
    let resolveCheck!: (value: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    render(<AgentSetupSection onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-setup-check"));
    fireEvent.change(screen.getByTestId("agent-setup-agent"), { target: { value: "codex" } });
    await act(async () => resolveCheck({ status: "installed", environment: "windows" }));
    expect(screen.queryByTestId("agent-setup-installed")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-setup-launch")).toBeDisabled();
    fireEvent.change(screen.getByTestId("agent-setup-agent"), { target: { value: "claude" } });
    expect(screen.queryByTestId("agent-setup-installed")).not.toBeInTheDocument();
  });
});
