import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaneGrid, type GridPane } from "./PaneGrid";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

const makePanes = (count: number): GridPane[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `pane-${i}`,
    view: { type: "TerminalView" as const },
    x: i * (1 / count),
    y: 0,
    w: 1 / count,
    h: 1,
  }));

describe("PaneGrid", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    // 기존 테스트는 hover를 기본 모드로 가정
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "hover" },
    }));
  });

  const defaultProps = {
    panes: makePanes(2),
    testIdFn: (_p: GridPane, i: number) => `test-pane-${i}`,
    isFocused: () => false,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test WS",
  };

  it("renders all panes with correct test ids", () => {
    render(<PaneGrid {...defaultProps} />);
    expect(screen.getByTestId("test-pane-0")).toBeInTheDocument();
    expect(screen.getByTestId("test-pane-1")).toBeInTheDocument();
  });

  it("calls onPaneFocus on mouseDown", () => {
    const onPaneFocus = vi.fn();
    render(<PaneGrid {...defaultProps} onPaneFocus={onPaneFocus} />);
    fireEvent.mouseDown(screen.getByTestId("test-pane-0"));
    expect(onPaneFocus).toHaveBeenCalledWith("pane-0");
  });

  it("renders FocusIndicator for focused pane", () => {
    render(<PaneGrid {...defaultProps} isFocused={(id) => id === "pane-0"} />);
    expect(screen.getByTestId("pane-focus-indicator")).toBeInTheDocument();
  });

  it("does not render FocusIndicator for unfocused panes", () => {
    render(<PaneGrid {...defaultProps} isFocused={() => false} />);
    expect(screen.queryByTestId("pane-focus-indicator")).not.toBeInTheDocument();
  });

  it("hides panes when isActive is false", () => {
    render(<PaneGrid {...defaultProps} isActive={false} />);
    const pane = screen.getByTestId("test-pane-0");
    expect(pane.style.display).toBe("none");
  });

  it("does not call onPaneFocus when isActive is false", () => {
    const onPaneFocus = vi.fn();
    render(<PaneGrid {...defaultProps} isActive={false} onPaneFocus={onPaneFocus} />);
    fireEvent.mouseDown(screen.getByTestId("test-pane-0"));
    expect(onPaneFocus).not.toHaveBeenCalled();
  });

  it("renders with containerTestId", () => {
    render(<PaneGrid {...defaultProps} containerTestId="my-grid" />);
    expect(screen.getByTestId("my-grid")).toBeInTheDocument();
  });

  it("calls onSplitPane via PaneControlBar split button", () => {
    const onSplitPane = vi.fn();
    render(<PaneGrid {...defaultProps} onSplitPane={onSplitPane} />);

    // Hover to show PaneControlBar
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    fireEvent.click(screen.getByTestId("pane-control-split-h"));

    expect(onSplitPane).toHaveBeenCalledWith("pane-0", "horizontal");
  });

  it("calls onRemovePane via PaneControlBar delete button", () => {
    const onRemovePane = vi.fn();
    render(<PaneGrid {...defaultProps} onRemovePane={onRemovePane} />);

    // Hover to show PaneControlBar
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    fireEvent.click(screen.getByTestId("pane-control-delete"));

    expect(onRemovePane).toHaveBeenCalledWith("pane-0");
  });
});
