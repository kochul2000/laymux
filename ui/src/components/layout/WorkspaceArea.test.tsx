import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: () => <div data-testid="mock-terminal">Terminal Mock</div>,
}));

import { WorkspaceArea } from "./WorkspaceArea";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
describe("WorkspaceArea", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    // 기존 테스트는 hover를 기본 모드로 가정
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "hover" },
    }));
  });

  it("renders workspace area container", () => {
    render(<WorkspaceArea />);
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
  });

  it("renders panes from active workspace", () => {
    render(<WorkspaceArea />);
    const panes = screen.getAllByTestId(/^workspace-pane-/);
    expect(panes.length).toBeGreaterThan(0);
  });

  it("does not show pane control bar when not hovered", () => {
    render(<WorkspaceArea />);
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
  });

  it("shows pane control bar on hover with view selector and actions", async () => {
    const user = userEvent.setup();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    await user.hover(pane);

    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-view-select")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-h")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-v")).toBeInTheDocument();
  });

  it("changes pane view via control bar selector", () => {
    render(<WorkspaceArea />);

    // Trigger hover on pane
    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    const select = screen.getByTestId("pane-control-view-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "TerminalView:PowerShell" } });

    const active = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(active.panes[0].view.type).toBe("TerminalView");
    expect(active.panes[0].view.profile).toBe("PowerShell");
  });

  it("splits pane via control bar", () => {
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);
    fireEvent.click(screen.getByTestId("pane-control-split-h"));

    const active = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(active.panes).toHaveLength(2);
  });

  it("renders focus indicator overlay on focused pane", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    render(<WorkspaceArea />);

    const indicator = screen.getByTestId("pane-focus-indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator.style.boxShadow).toBe("inset 0 0 0 1px var(--accent)");
    expect(indicator.className).toContain("z-30");
  });

  it("renders dimmed focus indicator when app is not focused", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    useUiStore.setState({ isAppFocused: false });
    render(<WorkspaceArea />);

    const indicator = screen.getByTestId("pane-focus-indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator.style.boxShadow).toBe("inset 0 0 0 1px var(--accent-50)");
  });

  // -- Hover auto-hide --

  it("auto-hides pane control bar after mouse stops moving", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    // Advance time past the idle timeout (default 2s)
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("resets auto-hide timer on mouse move", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    // Advance almost to timeout
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // Move mouse to reset timer
    fireEvent.mouseMove(pane);

    // Advance past original timeout but not past reset
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    // Advance past reset timeout
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows menu again on mouse move after auto-hide", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    // Auto-hide
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();

    // Mouse move should re-show
    fireEvent.mouseMove(pane);
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("does not render focus indicator on unfocused panes", () => {
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    useGridStore.setState({ focusedPaneIndex: 0 });
    render(<WorkspaceArea />);

    // Only one focus indicator should exist (for focused pane)
    const indicators = screen.getAllByTestId("pane-focus-indicator");
    expect(indicators).toHaveLength(1);
  });

  it("sets focused pane on mouseDown inside MemoView textarea", () => {
    // Setup: split into 2 panes, set pane 1 as MemoView, focus pane 0
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    useWorkspaceStore.getState().setPaneView(1, { type: "MemoView" });
    useGridStore.setState({ focusedPaneIndex: 0 });

    render(<WorkspaceArea />);

    // mouseDown on pane 1's MemoView textarea should set focus to pane 1
    const textarea = screen.getByTestId("memo-textarea");
    fireEvent.mouseDown(textarea);

    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("does not mount panes for never-visited workspaces", () => {
    // Setup: create a second workspace (not yet activated)
    const store = useWorkspaceStore.getState();
    store.addWorkspace("WS2", store.layouts[0].id);

    render(<WorkspaceArea />);

    // Active workspace panes should render
    expect(screen.getByTestId("workspace-pane-0")).toBeInTheDocument();

    // Only the active workspace's panes should be rendered
    const activePanes = screen.getAllByTestId(/^workspace-pane-/);
    const activeWs = useWorkspaceStore.getState().workspaces[0];
    expect(activePanes).toHaveLength(activeWs.panes.length);
  });

  it("mounts workspace panes when first activated", () => {
    // Setup: create a second workspace
    const store = useWorkspaceStore.getState();
    store.addWorkspace("WS2", store.layouts[0].id);
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;

    render(<WorkspaceArea />);

    // Switch to WS2
    act(() => {
      useWorkspaceStore.getState().setActiveWorkspace(ws2Id);
    });

    // WS2 panes should now be visible
    expect(screen.getByTestId("workspace-pane-0")).toBeInTheDocument();
  });

  it("keeps previously-visited workspace mounted after switching away", () => {
    // Setup: create two workspaces
    const store = useWorkspaceStore.getState();
    store.addWorkspace("WS2", store.layouts[0].id);
    const ws1Id = useWorkspaceStore.getState().workspaces[0].id;
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;

    render(<WorkspaceArea />);

    // Visit WS2
    act(() => {
      useWorkspaceStore.getState().setActiveWorkspace(ws2Id);
    });

    // Switch back to WS1
    act(() => {
      useWorkspaceStore.getState().setActiveWorkspace(ws1Id);
    });

    // Both workspaces should have their pane divs in the DOM
    // WS1 panes visible, WS2 panes hidden (display: none)
    const allDivs = document.querySelectorAll("[data-testid='workspace-area'] [class*='absolute']");
    const hiddenDivs = Array.from(allDivs).filter(
      (el) => (el as HTMLElement).style.display === "none",
    );
    // WS2 panes should be hidden but present
    expect(hiddenDivs.length).toBeGreaterThan(0);
  });

  it("preserves pane DOM elements when workspaces are reordered", () => {
    // Setup: create 2 workspaces with distinct pane IDs
    const store = useWorkspaceStore.getState();
    store.addWorkspace("WS2", store.layouts[0].id);
    const wsIds = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
    expect(wsIds).toHaveLength(2);

    render(<WorkspaceArea />);

    // Find the active workspace's pane element before reorder
    const paneBefore = screen.getByTestId("workspace-pane-0");
    // Mark the DOM node so we can verify identity after reorder
    (paneBefore as HTMLElement).dataset.marker = "identity-check";

    // Reorder workspaces (swap order)
    act(() => {
      useWorkspaceStore.getState().reorderWorkspaces(wsIds[1], wsIds[0]);
    });

    // The same pane element should still be in the DOM (not remounted)
    const paneAfter = screen.getByTestId("workspace-pane-0");
    expect(paneAfter.dataset.marker).toBe("identity-check");
  });
});
