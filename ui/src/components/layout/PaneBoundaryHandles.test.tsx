import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";
import { useWorkspaceStore } from "@/stores/workspace-store";
describe("PaneBoundaryHandles", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  });

  it("renders nothing when only one pane exists", () => {
    const { container } = render(
      <PaneBoundaryHandles containerWidth={1000} containerHeight={600} />,
    );
    expect(container.querySelectorAll("[data-testid^='boundary-handle']")).toHaveLength(0);
  });

  it("renders boundary handles when multiple panes exist", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");

    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handles = screen.getAllByTestId(/^boundary-handle/);
    expect(handles.length).toBeGreaterThan(0);
  });

  it("renders vertical handle at correct position", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");
    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handle = screen.getByTestId(/^boundary-handle/);
    // Vertical boundary at x=0.5 → left: 50%
    expect(handle.style.left).toBe("50%");
  });

  it("renders horizontal handle at correct position", () => {
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handle = screen.getByTestId(/^boundary-handle/);
    // Horizontal boundary at y=0.5 → top: 50%
    expect(handle.style.top).toBe("50%");
  });

  it("applies correct cursor style for vertical handle", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");
    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handle = screen.getByTestId(/^boundary-handle/);
    expect(handle.style.cursor).toBe("col-resize");
  });

  it("applies correct cursor style for horizontal handle", () => {
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handle = screen.getByTestId(/^boundary-handle/);
    expect(handle.style.cursor).toBe("row-resize");
  });

  it("handles double-click to merge panes", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");
    render(<PaneBoundaryHandles containerWidth={1000} containerHeight={600} />);
    const handle = screen.getByTestId(/^boundary-handle/);

    // Before merge: 2 panes
    expect(useWorkspaceStore.getState().getActiveWorkspace()!.panes).toHaveLength(2);

    fireEvent.doubleClick(handle);

    // After merge: 1 pane (smaller absorbed by larger)
    expect(useWorkspaceStore.getState().getActiveWorkspace()!.panes).toHaveLength(1);
  });
});
