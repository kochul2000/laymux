import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({}),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onLxNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getListeningPorts: vi.fn().mockResolvedValue([]),
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  loadMemo: vi.fn().mockResolvedValue(""),
  saveMemo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock TerminalView to capture props
const terminalViewProps: { syncGroup?: string; profile?: string }[] = [];
vi.mock("./TerminalView", () => ({
  TerminalView: (props: { instanceId: string; profile: string; syncGroup: string }) => {
    terminalViewProps.push({ syncGroup: props.syncGroup, profile: props.profile });
    return (
      <div
        data-testid="mock-terminal"
        data-syncgroup={props.syncGroup}
        data-profile={props.profile}
      />
    );
  },
}));

import { ViewRenderer } from "./ViewRenderer";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("ViewRenderer", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    terminalViewProps.length = 0;
  });

  it("renders EmptyView for EmptyView type", () => {
    render(<ViewRenderer viewType="EmptyView" />);
    expect(screen.getByTestId("empty-view")).toBeInTheDocument();
  });

  it("passes syncGroup from viewConfig to TerminalView", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", syncGroup: "MyGroup" }}
        workspaceName="Default"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("MyGroup");
  });

  it("defaults syncGroup to workspaceId when syncGroup is empty", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", syncGroup: "" }}
        workspaceName="ProjectA"
        workspaceId="ws-abc123"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("ws-abc123");
  });

  it("defaults syncGroup to workspaceId when syncGroup is not specified", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="ProjectB"
        workspaceId="ws-def456"
      />,
    );
    expect(terminalViewProps.at(-1)?.syncGroup).toBe("ws-def456");
  });

  it("passes profile from viewConfig to TerminalView", () => {
    render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView", profile: "WSL" }}
      />,
    );
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("defaults profile to settings defaultProfile when viewConfig has no profile", () => {
    useSettingsStore.setState({ defaultProfile: "WSL" });
    render(<ViewRenderer viewType="TerminalView" viewConfig={{ type: "TerminalView" }} />);
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("defaults profile to settings defaultProfile when viewConfig is undefined", () => {
    useSettingsStore.setState({ defaultProfile: "WSL" });
    render(<ViewRenderer viewType="TerminalView" />);
    expect(terminalViewProps.at(-1)?.profile).toBe("WSL");
  });

  it("falls back to PowerShell when no profile and no defaultProfile set", () => {
    useSettingsStore.setState({ defaultProfile: "" });
    render(<ViewRenderer viewType="TerminalView" viewConfig={{ type: "TerminalView" }} />);
    expect(terminalViewProps.at(-1)?.profile).toBe("PowerShell");
  });

  it("renders MemoView with data-testid", () => {
    render(<ViewRenderer viewType="MemoView" viewConfig={{ type: "MemoView" }} paneId="pane-99" />);
    expect(screen.getByTestId("view-memo")).toBeInTheDocument();
    expect(screen.getByTestId("memo-textarea")).toBeInTheDocument();
  });

  it("MemoView does not use onSelectView", () => {
    const onSelectView = vi.fn();
    render(
      <ViewRenderer
        viewType="MemoView"
        viewConfig={{ type: "MemoView" }}
        paneId="pane-99"
        onSelectView={onSelectView}
      />,
    );
    expect(onSelectView).not.toHaveBeenCalled();
  });

  it("uses paneId for stable terminal instanceId", () => {
    const { rerender } = render(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
        paneId="pane-42"
      />,
    );
    const terminal = screen.getByTestId("mock-terminal");
    // instanceId should be derived from paneId, not a random counter
    // Re-render with the same paneId should produce the same instanceId
    rerender(
      <ViewRenderer
        viewType="TerminalView"
        viewConfig={{ type: "TerminalView" }}
        workspaceName="Default"
        paneId="pane-42"
      />,
    );
    // The mock captures syncGroup; we mainly assert that the component
    // rendered without creating a new instance by checking testid is still present
    expect(screen.getByTestId("mock-terminal")).toBe(terminal);
  });
});
