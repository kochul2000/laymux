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
describe("WorkspaceArea", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
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
    expect(indicator.style.zIndex).toBe("20");
  });

  // -- Hover auto-hide --

  it("auto-hides pane control bar after mouse stops moving", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    // Advance time past the idle timeout (default 2s)
    act(() => { vi.advanceTimersByTime(2000); });

    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("resets auto-hide timer on mouse move", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    // Advance almost to timeout
    act(() => { vi.advanceTimersByTime(1500); });

    // Move mouse to reset timer
    fireEvent.mouseMove(pane);

    // Advance past original timeout but not past reset
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    // Advance past reset timeout
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows menu again on mouse move after auto-hide", () => {
    vi.useFakeTimers();
    render(<WorkspaceArea />);

    const pane = screen.getByTestId("workspace-pane-0");
    fireEvent.mouseEnter(pane);

    // Auto-hide
    act(() => { vi.advanceTimersByTime(3000); });
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
});
