import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock TerminalView to avoid Tauri IPC dependency
vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: (props: { instanceId: string }) => (
    <div data-testid={`mock-terminal-${props.instanceId}`}>MockTerminal</div>
  ),
}));

// 1회성 CWD 전파 버튼이 호출하는 백엔드 invoke 를 stub 한다 (issue #293).
// 나머지 tauri-api 함수(FileExplorerView 등이 마운트 시 사용)는 실제 구현을 유지한다.
// 단, 이벤트 리스너(onSyncCwd/onTerminalCwdChanged)는 실제 Tauri `listen` 을 호출해
// jsdom 에서 throw 하므로 no-op 으로 stub 한다.
const propagateCwdOnceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-api")>();
  return {
    ...actual,
    propagateCwdOnce: (terminalId: string) => propagateCwdOnceMock(terminalId),
    onSyncCwd: vi.fn().mockResolvedValue(vi.fn()),
    onTerminalCwdChanged: vi.fn().mockResolvedValue(vi.fn()),
  };
});

import { PaneGrid, type GridPane } from "./PaneGrid";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useCwdPropagateStore } from "@/stores/cwd-propagate-store";

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
      controlBar: { ...s.controlBar, defaultMode: "hover" },
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
        controlBar: { ...s.controlBar, defaultMode: "pinned" },
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

  // -- Drag-and-drop pane swap (issue #377) --
  //
  // 워크스페이스 그리드 안에서 pane을 드래그해 다른 pane 위로 드롭하면 두 pane의
  // 위치가 교환된다. PaneGrid는 onSwapPanes(srcPaneId, tgtPaneId) 콜백만 노출하고
  // 실제 위치 교환은 workspace-store.swapPanes(기존 로직)가 담당한다.
  describe("drag-to-swap (issue #377)", () => {
    const dndProps = {
      ...defaultProps,
      panes: makePanes(3),
      testIdFn: (_p: GridPane, i: number) => `test-pane-${i}`,
    };

    // dataTransfer is not implemented in jsdom; provide a minimal stub factory.
    const makeDataTransfer = () => ({
      data: {} as Record<string, string>,
      setData(type: string, val: string) {
        this.data[type] = val;
      },
      getData(type: string) {
        return this.data[type] ?? "";
      },
      effectAllowed: "",
      dropEffect: "",
    });

    it("renders a drag handle for each pane only when onSwapPanes is provided", () => {
      const { unmount } = render(<PaneGrid {...dndProps} />);
      expect(screen.queryByTestId("pane-drag-handle-0")).not.toBeInTheDocument();
      unmount();

      render(<PaneGrid {...dndProps} onSwapPanes={vi.fn()} />);
      expect(screen.getByTestId("pane-drag-handle-0")).toBeInTheDocument();
      expect(screen.getByTestId("pane-drag-handle-2")).toBeInTheDocument();
    });

    it("calls onSwapPanes with source and target pane ids on drop", () => {
      const onSwapPanes = vi.fn();
      render(<PaneGrid {...dndProps} onSwapPanes={onSwapPanes} />);

      const handle0 = screen.getByTestId("pane-drag-handle-0");
      const target2 = screen.getByTestId("test-pane-2");
      const dataTransfer = makeDataTransfer();

      fireEvent.dragStart(handle0, { dataTransfer });
      fireEvent.dragOver(target2, { dataTransfer });
      fireEvent.drop(target2, { dataTransfer });

      expect(onSwapPanes).toHaveBeenCalledWith("pane-0", "pane-2");
    });

    it("does not call onSwapPanes when dropping a pane onto itself", () => {
      const onSwapPanes = vi.fn();
      render(<PaneGrid {...dndProps} onSwapPanes={onSwapPanes} />);

      const handle1 = screen.getByTestId("pane-drag-handle-1");
      const target1 = screen.getByTestId("test-pane-1");
      const dataTransfer = makeDataTransfer();

      fireEvent.dragStart(handle1, { dataTransfer });
      fireEvent.dragOver(target1, { dataTransfer });
      fireEvent.drop(target1, { dataTransfer });

      expect(onSwapPanes).not.toHaveBeenCalled();
    });

    it("does not render drag handles when isActive is false", () => {
      render(<PaneGrid {...dndProps} onSwapPanes={vi.fn()} isActive={false} />);
      expect(screen.queryByTestId("pane-drag-handle-0")).not.toBeInTheDocument();
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

  // 1회성 CWD 전파 (issue #293)
  it("propagates CWD once with the terminal instanceId on click", () => {
    propagateCwdOnceMock.mockClear();
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
    render(<PaneGrid {...defaultProps} panes={onePane} onSetPaneView={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    fireEvent.click(screen.getByTestId("pane-control-cwd-propagate-once"));
    // ViewRenderer 의 TerminalView instanceId 규칙(`terminal-${paneId}`)과 일치해야 한다.
    expect(propagateCwdOnceMock).toHaveBeenCalledTimes(1);
    expect(propagateCwdOnceMock).toHaveBeenCalledWith("terminal-pane-x");
  });

  // file explorer 는 백엔드 PTY 세션이 없어 propagate_cwd_once 커맨드를 쓰면
  // Session not found 로 무음 실패한다(issue #293). 대신 cwd-propagate-store 의
  // 요청 카운터를 올려, cwd 를 아는 FileExplorerView 가 force sync-cwd 를 디스패치하게 한다.
  it("requests a propagate via the store for FileExplorerView (no backend invoke)", () => {
    propagateCwdOnceMock.mockClear();
    useCwdPropagateStore.setState({ requests: {} });
    const onePane: GridPane[] = [
      {
        id: "pane-fe",
        view: { type: "FileExplorerView" },
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    render(<PaneGrid {...defaultProps} panes={onePane} onSetPaneView={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    fireEvent.click(screen.getByTestId("pane-control-cwd-propagate-once"));
    // 백엔드 커맨드는 호출되지 않고, 스토어 요청 카운터가 증가해야 한다.
    expect(propagateCwdOnceMock).not.toHaveBeenCalled();
    expect(useCwdPropagateStore.getState().requests["pane-fe"]).toBe(1);
  });
});
