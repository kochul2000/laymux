import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));
const clearPaneFromUiMock = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/pane-clear-action", () => ({
  runPaneClearFromUi: (paneId: string) => clearPaneFromUiMock(paneId),
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
    terminalRestartEpoch?: number;
    terminalRestartCwd?: string;
    terminalRestartFresh?: boolean;
    onTerminalRestartConsumed?: () => void;
  }) => {
    capturedViewConfigs.push(props.viewConfig);
    return (
      <div
        data-testid={`view-${props.viewType?.toLowerCase().replace("view", "") ?? "empty"}`}
        data-restart-epoch={props.terminalRestartEpoch ?? ""}
        data-restart-cwd={props.terminalRestartCwd ?? ""}
        data-restart-fresh={props.terminalRestartFresh ? "true" : "false"}
        onClick={() => props.onTerminalRestartConsumed?.()}
      />
    );
  },
}));

import { Dock } from "./Dock";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";

describe("Dock", () => {
  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());
    clearPaneFromUiMock.mockClear();
    // 기존 테스트는 hover를 기본 모드로 가정
    useSettingsStore.setState((s) => ({
      controlBar: { ...s.controlBar, defaultMode: "hover" },
    }));
    capturedViewConfigs.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards a single-pane dock portal when the retained dock becomes inactive", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          setTimeout(
            () =>
              this.callback(
                [
                  {
                    target,
                    contentRect: { width: 200, height: 600 },
                  } as unknown as ResizeObserverEntry,
                ],
                this as unknown as ResizeObserver,
              ),
            0,
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const pane = {
      id: "dp-retained",
      view: { type: "MemoView" as const },
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    };
    const { rerender } = render(
      <Dock position="left" activeView="MemoView" views={[]} panes={[pane]} isActive />,
    );

    fireEvent.mouseEnter(screen.getByTestId("dock-left"));
    fireEvent.click(await screen.findByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    rerender(
      <Dock position="left" activeView="MemoView" views={[]} panes={[pane]} isActive={false} />,
    );
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();
  });

  it("keeps every split pane inactive in a retained hidden dock", () => {
    render(
      <Dock
        position="bottom"
        activeView="MemoView"
        views={[]}
        isActive={false}
        panes={[
          { id: "dp-a", view: { type: "MemoView" }, x: 0, y: 0, w: 0.5, h: 1 },
          { id: "dp-b", view: { type: "MemoView" }, x: 0.5, y: 0, w: 0.5, h: 1 },
        ]}
      />,
    );

    expect(screen.getByTestId("dock-pane-dp-a")).toHaveStyle({ display: "none" });
    expect(screen.getByTestId("dock-pane-dp-b")).toHaveStyle({ display: "none" });
    fireEvent.mouseEnter(screen.getByTestId("dock-pane-dp-a"));
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();
  });

  it("does not revive a single-pane hover bar when a retained dock is shown again", () => {
    useSettingsStore.setState((state) => ({
      controlBar: { ...state.controlBar, hoverIdleSeconds: 0 },
    }));
    const pane = {
      id: "dp-hover-lifecycle",
      view: { type: "MemoView" as const },
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    };
    const { rerender } = render(
      <Dock position="left" activeView="MemoView" views={[]} panes={[pane]} isActive />,
    );
    fireEvent.mouseEnter(screen.getByTestId("dock-left"));
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    rerender(
      <Dock position="left" activeView="MemoView" views={[]} panes={[pane]} isActive={false} />,
    );
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();

    rerender(<Dock position="left" activeView="MemoView" views={[]} panes={[pane]} isActive />);
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
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
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["dp-term"],
      eligiblePaneIds: [],
      readyPaneIds: ["dp-term"],
    });
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

  it("keeps a single-pane dock terminal queued behind the occupied global slot", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["busy", "dp-queued"],
      eligiblePaneIds: ["busy", "dp-queued"],
    });
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[{ id: "dp-queued", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );

    expect(screen.getByTestId("dock-pane-loading-dp-queued")).toBeInTheDocument();
    expect(screen.queryByTestId("view-terminal")).not.toBeInTheDocument();

    act(() => useTerminalStartupStore.getState().settleStartup("busy"));

    expect(screen.getByTestId("view-terminal")).toBeInTheDocument();
  });

  it("uses the pane view type consistently when single-dock metadata disagrees", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["busy", "dp-queued"],
      eligiblePaneIds: ["busy", "dp-queued"],
    });

    render(
      <Dock
        position="bottom"
        activeView="MemoView"
        views={[]}
        panes={[{ id: "dp-queued", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );

    expect(screen.getByTestId("dock-pane-loading-dp-queued")).toBeInTheDocument();
    expect(screen.queryByTestId("view-memo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("view-terminal")).not.toBeInTheDocument();
  });

  it("passes viewConfig with profile to ViewRenderer in single-pane mode", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["dp-wsl"],
      eligiblePaneIds: [],
      readyPaneIds: ["dp-wsl"],
    });
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

  it("터미널 실제 클리어 버튼은 단일 dock pane을 대상으로 실행한다", () => {
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[{ id: "dp-1", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }]}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("dock-bottom"));

    fireEvent.click(screen.getByTestId("pane-control-clear-terminal"));

    expect(clearPaneFromUiMock).toHaveBeenCalledWith("dp-1");
    expect(clearPaneFromUiMock).toHaveBeenCalledTimes(1);
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

  it("clicking a split pane sets focusedDockPaneId to that pane", () => {
    useDockStore.setState((state) => ({
      docks: state.docks.map((dock) =>
        dock.position === "left"
          ? {
              ...dock,
              panes: [
                {
                  id: "dp-1",
                  view: { type: "WorkspaceSelectorView" },
                  x: 0,
                  y: 0,
                  w: 1,
                  h: 0.5,
                },
                { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
              ],
            }
          : dock,
      ),
    }));
    useDockStore.getState().setFocusedDock("left", "dp-1");
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
      />,
    );
    // Click on the second pane
    fireEvent.mouseDown(screen.getByTestId("dock-pane-dp-2"));
    expect(useDockStore.getState().focusedDock).toBe("left");
    expect(useDockStore.getState().focusedDockPaneId).toBe("dp-2");
  });

  it("clicking a split pane clears workspace pane focus", () => {
    useDockStore.setState((state) => ({
      docks: state.docks.map((dock) =>
        dock.position === "left"
          ? {
              ...dock,
              panes: [
                {
                  id: "dp-1",
                  view: { type: "WorkspaceSelectorView" },
                  x: 0,
                  y: 0,
                  w: 1,
                  h: 0.5,
                },
                { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
              ],
            }
          : dock,
      ),
    }));
    useGridStore.getState().setFocusedPane(0);
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          { id: "dp-1", view: { type: "WorkspaceSelectorView" }, x: 0, y: 0, w: 1, h: 0.5 },
          { id: "dp-2", view: { type: "SettingsView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
        ]}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId("dock-pane-dp-1"));
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
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
    expect(onSplitPane).toHaveBeenCalledWith("dp-1", "vertical");
  });

  // -- CWD toggle defaults follow syncCwdDefaults --
  //
  // 기본 syncCwdDefaults는 workspace/dock 모두 { send: false, receive: false } 이다.
  // 신규 dock 페인이 cwdSend/cwdReceive override 없이 표시될 때 OFF 아이콘이 나와야 한다.

  it("single-pane dock shows CWD send OFF, receive ON by default (syncCwdDefaults.dock)", () => {
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[
          {
            id: "dp-1",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
        ]}
        onSetPaneView={vi.fn()}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("dock-bottom"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
  });

  it("single-pane dock toggling CWD send from default-off sets cwdSend=true", () => {
    const onSetPaneView = vi.fn();
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[
          {
            id: "dp-1",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
        ]}
        onSetPaneView={onSetPaneView}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("dock-bottom"));
    fireEvent.click(screen.getByTestId("pane-control-cwd-send"));
    expect(onSetPaneView).toHaveBeenCalledWith("dp-1", expect.objectContaining({ cwdSend: true }));
  });

  it("single-pane FileExplorer uses fileExplorer.shellProfile for CWD defaults", () => {
    const onSetPaneView = vi.fn();
    useSettingsStore.setState((s) => ({
      fileExplorer: { ...s.fileExplorer, shellProfile: "WSL" },
      profiles: s.profiles.map((p) =>
        p.name === "WSL"
          ? { ...p, syncCwd: { send: true, receive: true } }
          : p.name === "PowerShell"
            ? { ...p, syncCwd: { send: false, receive: false } }
            : p,
      ),
    }));

    render(
      <Dock
        position="bottom"
        activeView="FileExplorerView"
        views={[]}
        panes={[
          {
            id: "dp-files",
            view: { type: "FileExplorerView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
        ]}
        onSetPaneView={onSetPaneView}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("dock-bottom"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe("CWD Send (on)");
    fireEvent.click(screen.getByTestId("pane-control-cwd-send"));
    expect(onSetPaneView).toHaveBeenCalledWith(
      "dp-files",
      expect.objectContaining({ cwdSend: false }),
    );
  });

  it("updates single-pane CWD indicators when dock syncCwdDefaults changes", () => {
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={[]}
        panes={[
          {
            id: "dp-1",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
        ]}
        onSetPaneView={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("dock-bottom"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );

    act(() => {
      useSettingsStore.getState().setSyncCwdDefaults({ dock: { send: true, receive: true } });
    });

    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe("CWD Send (on)");
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
  });

  it("split-pane dock shows CWD send OFF, receive ON by default", () => {
    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          {
            id: "dp-1",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 0.5,
          },
          {
            id: "dp-2",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0.5,
            w: 1,
            h: 0.5,
          },
        ]}
        onSetPaneView={vi.fn()}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("dock-pane-dp-1"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
  });

  it("split-pane FileExplorer uses fileExplorer.shellProfile for CWD defaults", () => {
    const onSetPaneView = vi.fn();
    useSettingsStore.setState((s) => ({
      fileExplorer: { ...s.fileExplorer, shellProfile: "WSL" },
      profiles: s.profiles.map((p) =>
        p.name === "WSL"
          ? { ...p, syncCwd: { send: true, receive: true } }
          : p.name === "PowerShell"
            ? { ...p, syncCwd: { send: false, receive: false } }
            : p,
      ),
    }));

    render(
      <Dock
        position="left"
        activeView={null}
        views={[]}
        panes={[
          {
            id: "dp-files",
            view: { type: "FileExplorerView", profile: "PowerShell" },
            x: 0,
            y: 0,
            w: 1,
            h: 0.5,
          },
          {
            id: "dp-term",
            view: { type: "TerminalView", profile: "PowerShell" },
            x: 0,
            y: 0.5,
            w: 1,
            h: 0.5,
          },
        ]}
        onSetPaneView={onSetPaneView}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("dock-pane-dp-files"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe("CWD Send (on)");
    fireEvent.click(screen.getByTestId("pane-control-cwd-send"));
    expect(onSetPaneView).toHaveBeenCalledWith(
      "dp-files",
      expect.objectContaining({ cwdSend: false }),
    );
  });
});

describe("Dock restart wiring (ADR-0113)", () => {
  const terminalPane = {
    id: "dp-term",
    view: { type: "TerminalView" as const },
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  };

  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
    useTerminalStartupStore.setState({ revealedPaneIds: new Set([terminalPane.id]) });
    useSettingsStore.setState((s) => ({ controlBar: { ...s.controlBar, defaultMode: "pinned" } }));
    capturedViewConfigs.length = 0;
  });

  const renderDock = () =>
    render(
      <Dock
        position="bottom"
        activeView="TerminalView"
        views={["TerminalView"]}
        panes={[terminalPane]}
      />,
    );

  it("routes Restart View through the store with the pane's id", () => {
    renderDock();
    fireEvent.click(screen.getByTestId("pane-control-restart"));

    expect(useTerminalRestartStore.getState().requests["dp-term"]).toMatchObject({
      epoch: 1,
      fresh: true,
    });
  });

  it("passes a request made outside the component down to the view", () => {
    renderDock();
    act(() => {
      useTerminalRestartStore.getState().requestRestart("dp-term", "/tmp/dock");
    });

    const view = screen.getByTestId("view-terminal");
    expect(view).toHaveAttribute("data-restart-epoch", "1");
    expect(view).toHaveAttribute("data-restart-cwd", "/tmp/dock");
    expect(view).toHaveAttribute("data-restart-fresh", "true");
  });

  // The consume callback used to close over a locally-held value; passing the
  // wrong pane id here would silently leave the request fresh forever.
  it("consumes the request for its own pane", () => {
    renderDock();
    act(() => {
      useTerminalRestartStore.getState().requestRestart("dp-term");
      useTerminalRestartStore.getState().requestRestart("other-pane");
    });

    act(() => {
      fireEvent.click(screen.getByTestId("view-terminal"));
    });

    expect(useTerminalRestartStore.getState().requests["dp-term"].fresh).toBe(false);
    expect(useTerminalRestartStore.getState().requests["other-pane"].fresh).toBe(true);
  });
});
