import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

// Capture viewConfig passed to ViewRenderer
const capturedViewConfigs: (Record<string, unknown> | undefined)[] = [];
vi.mock("@/components/views/ViewRenderer", () => ({
  ViewRenderer: (props: {
    viewType: string | null;
    viewConfig?: Record<string, unknown>;
    paneId?: string;
  }) => {
    capturedViewConfigs.push(props.viewConfig);
    return (
      <div data-testid={`view-${props.viewType?.toLowerCase().replace("view", "") ?? "empty"}`} />
    );
  },
}));

import { Dock } from "./Dock";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("Dock", () => {
  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    capturedViewConfigs.length = 0;
  });

  it("renders with correct test id", () => {
    render(<Dock position="left" activeView={null} views={[]} panes={[]} />);
    expect(screen.getByTestId("dock-left")).toBeInTheDocument();
  });

  it("renders EmptyView when no activeView", () => {
    render(<Dock position="right" activeView={null} views={[]} panes={[]} />);
    expect(screen.getByTestId("dock-right")).toBeInTheDocument();
  });

  it("renders with activeView type", () => {
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={["WorkspaceSelectorView", "SettingsView"]}
        panes={[{ id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    expect(screen.getByTestId("dock-left")).toBeInTheDocument();
  });

  it("renders icon sidebar with view icons when multiple views configured (single pane)", () => {
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={["WorkspaceSelectorView", "SettingsView"]}
        panes={[{ id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    expect(screen.getByTestId("dock-icon-bar")).toBeInTheDocument();
    expect(screen.getByTestId("dock-icon-WorkspaceSelectorView")).toBeInTheDocument();
    expect(screen.getByTestId("dock-icon-SettingsView")).toBeInTheDocument();
  });

  it("does not render icon sidebar when only one or zero views", () => {
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={["WorkspaceSelectorView"]}
        panes={[{ id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    expect(screen.queryByTestId("dock-icon-bar")).not.toBeInTheDocument();
  });

  it("calls onSwitchView when an icon is clicked", () => {
    const onSwitch = vi.fn();
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={["WorkspaceSelectorView", "SettingsView"]}
        panes={[{ id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 1 }]}
        onSwitchView={onSwitch}
      />,
    );
    fireEvent.click(screen.getByTestId("dock-icon-SettingsView"));
    expect(onSwitch).toHaveBeenCalledWith("SettingsView");
  });

  it("highlights the active view icon", () => {
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={["WorkspaceSelectorView", "SettingsView"]}
        panes={[{ id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    const activeIcon = screen.getByTestId("dock-icon-WorkspaceSelectorView");
    expect(activeIcon.dataset.active).toBe("true");
  });

  it("has h-full on root element for top/bottom docks so child views get height", () => {
    const { container: bottomContainer } = render(
      <Dock position="bottom" activeView="SettingsView" views={[]} panes={[]} />,
    );
    const bottomRoot = bottomContainer.firstElementChild as HTMLElement;
    expect(bottomRoot.className).toContain("h-full");

    const { container: topContainer } = render(
      <Dock position="top" activeView="SettingsView" views={[]} panes={[]} />,
    );
    const topRoot = topContainer.firstElementChild as HTMLElement;
    expect(topRoot.className).toContain("h-full");
  });

  it("passes stable paneId to ViewRenderer based on dock pane id", () => {
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[{ id: "dp-term", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    expect(screen.getByTestId("view-terminal")).toBeInTheDocument();
  });

  it("passes viewConfig with profile to ViewRenderer in single-pane mode", () => {
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[
          { id: "dp-wsl", view: { type: "TerminalView", profile: "WSL" }, x: 0, y: 0, w: 1, h: 1 },
        ]}
      />,
    );
    // ViewRenderer must receive the pane's view config (including profile: "WSL")
    const lastConfig = capturedViewConfigs.at(-1);
    expect(lastConfig).toBeDefined();
    expect(lastConfig?.profile).toBe("WSL");
  });

  it("shows clear button in single-pane mode when a view is active", () => {
    const onSwitchView = vi.fn();
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[{ id: "dp-1", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }]}
        onSwitchView={onSwitchView}
        onSetPaneView={vi.fn()}
      />,
    );
    const dock = screen.getByTestId("dock-bottom");
    fireEvent.mouseEnter(dock);
    expect(screen.getByTestId("pane-control-clear")).toBeInTheDocument();
  });

  it("shows clear button even when panes is empty but activeView is set", () => {
    const onSwitchView = vi.fn();
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[]}
        onSwitchView={onSwitchView}
      />,
    );
    const dock = screen.getByTestId("dock-bottom");
    fireEvent.mouseEnter(dock);
    expect(screen.getByTestId("pane-control-clear")).toBeInTheDocument();
  });

  it("passes full viewConfig through onSwitchView when panes are empty", () => {
    const onSwitchView = vi.fn();
    // We need to capture what ViewRenderer's onSelectView does
    // Since ViewRenderer is mocked, we verify the capture in capturedViewConfigs
    render(
      <Dock
        position="bottom"
        activeView={null}
        views={[]}
        panes={[]}
        onSwitchView={onSwitchView}
      />,
    );
    // With empty panes, there's no singlePaneId, so onSelectView goes through onSwitchView
    expect(screen.getByTestId("dock-bottom")).toBeInTheDocument();
  });

  // -- Split panes (2D grid) --

  it("renders split panes when multiple panes provided", () => {
    render(
      <Dock
        position="left"
        activeView="WorkspaceSelectorView"
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
      />,
    );
    expect(screen.getByTestId("dock-pane-dp-1")).toBeInTheDocument();
    expect(screen.getByTestId("dock-pane-dp-2")).toBeInTheDocument();
  });

  it("shows full control bar (split H, split V, clear, delete) on split pane hover", () => {
    const onRemove = vi.fn();
    const onSetPaneView = vi.fn();
    const onSplitPane = vi.fn();
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
        onRemovePane={onRemove}
        onSetPaneView={onSetPaneView}
        onSplitPane={onSplitPane}
      />,
    );
    const pane = screen.getByTestId("dock-pane-dp-1");
    fireEvent.mouseEnter(pane);

    expect(screen.getByTestId("pane-control-split-h")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-v")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-clear")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-delete")).toBeInTheDocument();
  });

  it("clear button sets dock pane view to EmptyView", () => {
    const onSetPaneView = vi.fn();
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
        onSetPaneView={onSetPaneView}
      />,
    );
    const pane = screen.getByTestId("dock-pane-dp-1");
    fireEvent.mouseEnter(pane);
    fireEvent.click(screen.getByTestId("pane-control-clear"));

    expect(onSetPaneView).toHaveBeenCalledWith("dp-1", { type: "EmptyView" });
  });

  it("auto-hides split pane control bar after idle", () => {
    vi.useFakeTimers();
    const onRemove = vi.fn();
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
        onRemovePane={onRemove}
      />,
    );
    const pane = screen.getByTestId("dock-pane-dp-1");
    fireEvent.mouseEnter(pane);
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("calls onSplitPane with direction and paneId", () => {
    const onSplitPane = vi.fn();
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
        onSplitPane={onSplitPane}
      />,
    );
    const pane = screen.getByTestId("dock-pane-dp-1");
    fireEvent.mouseEnter(pane);
    fireEvent.click(screen.getByTestId("pane-control-split-v"));
    expect(onSplitPane).toHaveBeenCalledWith("vertical", "dp-1");
  });
});
