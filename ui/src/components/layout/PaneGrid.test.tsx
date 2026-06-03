import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock TerminalView to avoid Tauri IPC dependency
vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: (props: { instanceId: string }) => (
    <div data-testid={`mock-terminal-${props.instanceId}`}>MockTerminal</div>
  ),
}));

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
    workspaceName: "Test-WS",
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

  describe("pane number badges (issue #256)", () => {
    // Array order [TL, BL, TR] (as splice-based splitting produces) must map to
    // reading-order numbers TL=1, TR=2, BL=3 regardless of array index.
    const spatialPanes: GridPane[] = [
      { id: "TL", view: { type: "TerminalView" }, x: 0, y: 0, w: 0.5, h: 0.5 },
      { id: "BL", view: { type: "TerminalView" }, x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { id: "TR", view: { type: "TerminalView" }, x: 0.5, y: 0, w: 0.5, h: 0.5 },
    ];
    const props = {
      ...defaultProps,
      panes: spatialPanes,
      testIdFn: (p: GridPane) => `pane-box-${p.id}`,
    };

    beforeEach(() => {
      // Pinned bar is always visible so the badge renders without hover.
      useSettingsStore.setState((s) => ({
        convenience: { ...s.convenience, defaultControlBarMode: "pinned" },
      }));
    });

    it("shows reading-order badges when showPaneNumbers is set", () => {
      render(<PaneGrid {...props} showPaneNumbers />);
      const badgeIn = (id: string) =>
        within(screen.getByTestId(`pane-box-${id}`)).getByTestId("pane-number-badge");
      expect(badgeIn("TL")).toHaveTextContent("1");
      expect(badgeIn("TR")).toHaveTextContent("2");
      expect(badgeIn("BL")).toHaveTextContent("3");
    });

    it("does not show badges by default (dock reuse stays unnumbered)", () => {
      render(<PaneGrid {...props} />);
      expect(screen.queryByTestId("pane-number-badge")).not.toBeInTheDocument();
    });
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

  it("renders data-pane-index attribute on each pane div", () => {
    render(<PaneGrid {...defaultProps} />);
    const pane0 = screen.getByTestId("test-pane-0");
    const pane1 = screen.getByTestId("test-pane-1");
    expect(pane0.getAttribute("data-pane-index")).toBe("0");
    expect(pane1.getAttribute("data-pane-index")).toBe("1");
  });

  // -- CWD toggle indicator reflects getCwdDefaults --
  //
  // 기본값(off)인 신규 페인에서도 viewConfig에 cwdSend/cwdReceive override가 없으면
  // PaneControlBar 표시는 OFF여야 한다. (Regression: 표시는 ?? true로 폴백되어 ON으로 보였다)

  it("shows CWD send/receive as OFF when getCwdDefaults returns {send:false, receive:false} and no override", () => {
    const onePane: GridPane[] = [
      {
        id: "pane-x",
        view: { type: "TerminalView", profile: "PowerShell" },
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    render(
      <PaneGrid
        {...defaultProps}
        panes={onePane}
        onSetPaneView={vi.fn()}
        getCwdDefaults={() => ({ send: false, receive: false })}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (off)",
    );
  });

  it("shows CWD send/receive as ON when getCwdDefaults returns true and no override", () => {
    const onePane: GridPane[] = [
      {
        id: "pane-x",
        view: { type: "TerminalView", profile: "PowerShell" },
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    render(
      <PaneGrid
        {...defaultProps}
        panes={onePane}
        onSetPaneView={vi.fn()}
        getCwdDefaults={() => ({ send: true, receive: true })}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe("CWD Send (on)");
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
  });

  it("per-pane override beats getCwdDefaults (override=false, defaults=true → OFF)", () => {
    const onePane: GridPane[] = [
      {
        id: "pane-x",
        view: { type: "TerminalView", profile: "PowerShell", cwdSend: false, cwdReceive: false },
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    render(
      <PaneGrid
        {...defaultProps}
        panes={onePane}
        onSetPaneView={vi.fn()}
        getCwdDefaults={() => ({ send: true, receive: true })}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (off)",
    );
  });

  it("toggling CWD send from default-off (no override) sets cwdSend=true", () => {
    const onSetPaneView = vi.fn();
    const onePane: GridPane[] = [
      {
        id: "pane-x",
        view: { type: "TerminalView", profile: "PowerShell" },
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    render(
      <PaneGrid
        {...defaultProps}
        panes={onePane}
        onSetPaneView={onSetPaneView}
        getCwdDefaults={() => ({ send: false, receive: false })}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    fireEvent.click(screen.getByTestId("pane-control-cwd-send"));
    expect(onSetPaneView).toHaveBeenCalledWith(
      "pane-x",
      expect.objectContaining({ cwdSend: true }),
    );
  });
});
