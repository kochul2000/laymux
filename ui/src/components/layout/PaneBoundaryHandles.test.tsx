import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";
import { useWorkspaceStore } from "@/stores/workspace-store";
describe("PaneBoundaryHandles", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    // The shipped default workspace now opens as a 2-pane split; these tests
    // assume a single full pane as their starting point.
    const st = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      workspaces: st.workspaces.map((w) =>
        w.id === st.activeWorkspaceId
          ? { ...w, panes: [{ ...w.panes[0], x: 0, y: 0, w: 1, h: 1 }] }
          : w,
      ),
    });
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

  it("drags one merged vertical handle to resize all panes on the split side", () => {
    const panes = [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];

    render(
      <PaneBoundaryHandles
        containerWidth={1000}
        containerHeight={600}
        panes={panes}
        getLatestPanes={() => panes}
        onResizePane={(index, delta) => {
          panes[index] = { ...panes[index], ...delta };
        }}
      />,
    );

    const handles = screen.getAllByTestId(/^boundary-handle/);
    const verticalHandles = handles.filter((handle) => handle.style.cursor === "col-resize");
    expect(verticalHandles).toHaveLength(1);

    fireEvent.mouseDown(verticalHandles[0], { clientX: 500, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 600, clientY: 100 });
    fireEvent.mouseUp(document);

    expect(panes[0].w).toBeCloseTo(0.6);
    expect(panes[1].x).toBeCloseTo(0.6);
    expect(panes[1].w).toBeCloseTo(0.4);
    expect(panes[2].x).toBeCloseTo(0.6);
    expect(panes[2].w).toBeCloseTo(0.4);
  });

  it("keeps all panes touching after dragging the [2, [1, 1]] boundary (no visual gap)", () => {
    // Reproduces the bug where only the segment under the cursor moved while the
    // other stacked pane stayed in place, leaving an empty band.
    const panes = [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];

    render(
      <PaneBoundaryHandles
        containerWidth={1000}
        containerHeight={600}
        panes={panes}
        getLatestPanes={() => panes}
        onResizePane={(index, delta) => {
          panes[index] = { ...panes[index], ...delta };
        }}
      />,
    );

    const verticalHandle = screen
      .getAllByTestId(/^boundary-handle/)
      .find((h) => h.style.cursor === "col-resize")!;

    fireEvent.mouseDown(verticalHandle, { clientX: 500, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 650, clientY: 100 });
    fireEvent.mouseUp(document);

    const leftRight = panes[0].x + panes[0].w;
    expect(panes[1].x).toBeCloseTo(leftRight);
    expect(panes[2].x).toBeCloseTo(leftRight);
    expect(panes[1].x + panes[1].w).toBeCloseTo(1);
    expect(panes[2].x + panes[2].w).toBeCloseTo(1);
  });
});
