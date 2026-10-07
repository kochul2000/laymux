import { render, screen, fireEvent, within, act, createEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock TerminalView to avoid Tauri IPC dependency
vi.mock("@/components/views/TerminalView", () => ({
  // The restart props are surfaced as data attributes so the store → ViewRenderer
  // → TerminalView wiring is assertable (ADR-0113); everything else ignores them.
  TerminalView: (props: {
    instanceId: string;
    restartCwd?: string;
    isUserRestart?: boolean;
    onUserRestartConsumed?: () => void;
  }) => (
    <div
      data-testid={`mock-terminal-${props.instanceId}`}
      data-restart-cwd={props.restartCwd ?? ""}
      data-user-restart={props.isUserRestart ? "true" : "false"}
      onClick={() => props.onUserRestartConsumed?.()}
    >
      MockTerminal
    </div>
  ),
}));

// 1회성 CWD 전파 버튼이 호출하는 백엔드 invoke 를 stub 한다 (issue #293).
// 나머지 tauri-api 함수(FileExplorerView 등이 마운트 시 사용)는 실제 구현을 유지한다.
// 단, 이벤트 리스너(onSyncCwd/onTerminalCwdChanged)는 실제 Tauri `listen` 을 호출해
// jsdom 에서 throw 하므로 no-op 으로 stub 한다.
const propagateCwdOnceMock = vi.fn().mockResolvedValue(undefined);
const clearPaneFromUiMock = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/pane-clear-action", () => ({
  runPaneClearFromUi: (paneId: string) => clearPaneFromUiMock(paneId),
}));
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
import { usePaneRevealStore } from "@/stores/pane-reveal-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";

const makePanes = (count: number): GridPane[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `pane-${i}`,
    layers: [{ id: `pane-${i}`, view: { type: "TerminalView" as const } }],
    activeLayerId: `pane-${i}`,
    x: i * (1 / count),
    y: 0,
    w: 1 / count,
    h: 1,
  }));

describe("PaneGrid", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    usePaneRevealStore.setState(usePaneRevealStore.getInitialState());
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());
    clearPaneFromUiMock.mockClear();
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

  it("터미널 실제 클리어 버튼은 해당 격자 pane만 대상으로 실행한다", () => {
    render(<PaneGrid {...defaultProps} />);
    fireEvent.mouseEnter(screen.getByTestId("test-pane-1"));

    fireEvent.click(
      within(screen.getByTestId("test-pane-1")).getByTestId("pane-control-clear-terminal"),
    );

    expect(clearPaneFromUiMock).toHaveBeenCalledWith("pane-1");
    expect(clearPaneFromUiMock).toHaveBeenCalledTimes(1);
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

  it("does not revive stale hover after an inactive-to-active transition", () => {
    useSettingsStore.setState((state) => ({
      controlBar: { ...state.controlBar, hoverIdleSeconds: 0 },
    }));
    const { rerender } = render(<PaneGrid {...defaultProps} isActive />);
    fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();

    rerender(<PaneGrid {...defaultProps} isActive={false} />);
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();

    rerender(<PaneGrid {...defaultProps} isActive />);
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
  });

  it("renders with containerTestId", () => {
    render(<PaneGrid {...defaultProps} containerTestId="my-grid" />);
    expect(screen.getByTestId("my-grid")).toBeInTheDocument();
  });

  describe("pane number badges (issue #256)", () => {
    // Array order [TL, BL, TR] (as splice-based splitting produces) must map to
    // reading-order numbers TL=1, TR=2, BL=3 regardless of array index.
    const spatialPanes: GridPane[] = [
      {
        id: "TL",
        layers: [{ id: "TL", view: { type: "TerminalView" } }],
        activeLayerId: "TL",
        x: 0,
        y: 0,
        w: 0.5,
        h: 0.5,
      },
      {
        id: "BL",
        layers: [{ id: "BL", view: { type: "TerminalView" } }],
        activeLayerId: "BL",
        x: 0,
        y: 0.5,
        w: 0.5,
        h: 0.5,
      },
      {
        id: "TR",
        layers: [{ id: "TR", view: { type: "TerminalView" } }],
        activeLayerId: "TR",
        x: 0.5,
        y: 0,
        w: 0.5,
        h: 0.5,
      },
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

  // -- Drag-and-drop pane swap (issue #377, redesigned #386) --
  //
  // 워크스페이스 그리드 안에서 pane을 드래그해 다른 pane 위로 드롭하면 두 pane의
  // 위치가 교환된다. 별도 드래그 핸들 대신(issue #386: 핸들이 콘텐츠와 겹침) 컨트롤바
  // (PaneControlBar)의 버튼 없는 빈 영역을 드래그하면 swap 이 시작된다. PaneGrid는
  // onSwapPanes(srcPaneId, tgtPaneId) 콜백만 노출하고 실제 위치 교환은
  // workspace-store.swapPanes(기존 로직)가 담당한다.
  describe("drag-to-swap (issue #377 / #386)", () => {
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

    // 빈 영역(바 배경) 드래그를 모사하려면 dragStart 가 바 컨테이너 자신(currentTarget)을
    // target 으로 발생해야 한다. fireEvent.dragStart(bar) 는 target===bar 로 디스패치된다.
    const barOf = (i: number) =>
      within(screen.getByTestId(`test-pane-${i}`)).getByTestId("pane-control-bar");

    it("no longer renders the old floating drag handle (#386)", () => {
      render(<PaneGrid {...dndProps} onSwapPanes={vi.fn()} />);
      expect(screen.queryByTestId("pane-drag-handle-0")).not.toBeInTheDocument();
      expect(screen.queryByTestId("pane-drag-handle-2")).not.toBeInTheDocument();
    });

    it("control bar is draggable only when onSwapPanes is provided", () => {
      const { unmount } = render(<PaneGrid {...dndProps} />);
      fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
      expect(barOf(0).getAttribute("draggable")).not.toBe("true");
      unmount();

      render(<PaneGrid {...dndProps} onSwapPanes={vi.fn()} />);
      fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
      expect(barOf(0).getAttribute("draggable")).toBe("true");
    });

    it("dragging the control bar empty area swaps source and target panes on drop", () => {
      const onSwapPanes = vi.fn();
      render(<PaneGrid {...dndProps} onSwapPanes={onSwapPanes} />);

      fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
      const bar0 = barOf(0);
      const target2 = screen.getByTestId("test-pane-2");
      const dataTransfer = makeDataTransfer();

      fireEvent.dragStart(bar0, { dataTransfer });
      fireEvent.dragOver(target2, { dataTransfer });
      fireEvent.drop(target2, { dataTransfer });

      expect(onSwapPanes).toHaveBeenCalledWith("pane-0", "pane-2");
    });

    it("does not call onSwapPanes when dropping a pane onto itself", () => {
      const onSwapPanes = vi.fn();
      render(<PaneGrid {...dndProps} onSwapPanes={onSwapPanes} />);

      fireEvent.mouseEnter(screen.getByTestId("test-pane-1"));
      const bar1 = barOf(1);
      const target1 = screen.getByTestId("test-pane-1");
      const dataTransfer = makeDataTransfer();

      fireEvent.dragStart(bar1, { dataTransfer });
      fireEvent.dragOver(target1, { dataTransfer });
      fireEvent.drop(target1, { dataTransfer });

      expect(onSwapPanes).not.toHaveBeenCalled();
    });

    it("starting the drag on a control button does not begin a pane swap (click still works)", () => {
      const onSwapPanes = vi.fn();
      const onSplitPane = vi.fn();
      render(<PaneGrid {...dndProps} onSwapPanes={onSwapPanes} onSplitPane={onSplitPane} />);

      fireEvent.mouseEnter(screen.getByTestId("test-pane-0"));
      const btn = screen.getAllByTestId("pane-control-split-h")[0];
      const target2 = screen.getByTestId("test-pane-2");
      const dataTransfer = makeDataTransfer();

      // 버튼 위에서 시작한 drag: dragStart 가 currentTarget(바)이 아닌 버튼에서 발생하므로
      // preventDefault 로 무시되어 dataTransfer 에 paneId 가 실리지 않는다.
      fireEvent.dragStart(btn, { dataTransfer });
      fireEvent.dragOver(target2, { dataTransfer });
      fireEvent.drop(target2, { dataTransfer });
      expect(onSwapPanes).not.toHaveBeenCalled();

      // 버튼 클릭은 정상 동작한다.
      fireEvent.click(btn);
      expect(onSplitPane).toHaveBeenCalledWith("pane-0", "horizontal");
    });

    it("control bar is not draggable when isActive is false", () => {
      render(<PaneGrid {...dndProps} onSwapPanes={vi.fn()} isActive={false} />);
      // 비활성 워크스페이스는 hover 가 동작하지 않아 바 자체가 렌더되지 않는다.
      expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
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

    expect(onRemovePane).toHaveBeenCalledWith("pane-0", "pane-0");
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
        layers: [{ id: "pane-x", view: { type: "TerminalView", profile: "PowerShell" } }],
        activeLayerId: "pane-x",
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
        layers: [{ id: "pane-x", view: { type: "TerminalView", profile: "PowerShell" } }],
        activeLayerId: "pane-x",
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
        layers: [
          {
            id: "pane-x",
            view: {
              type: "TerminalView",
              profile: "PowerShell",
              cwdSend: false,
              cwdReceive: false,
            },
          },
        ],
        activeLayerId: "pane-x",
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
        layers: [{ id: "pane-x", view: { type: "TerminalView", profile: "PowerShell" } }],
        activeLayerId: "pane-x",
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
      "pane-x",
    );
  });

  // 1회성 CWD 전파 (issue #293)
  it("propagates CWD once with the terminal instanceId on click", () => {
    propagateCwdOnceMock.mockClear();
    const onePane: GridPane[] = [
      {
        id: "pane-x",
        layers: [{ id: "pane-x", view: { type: "TerminalView", profile: "PowerShell" } }],
        activeLayerId: "pane-x",
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
        layers: [{ id: "pane-fe", view: { type: "FileExplorerView" } }],
        activeLayerId: "pane-fe",
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

  // 흰 화면 방지 backstop: 위치 지정 pane <div> 는 항상 어두운 배경을 가져야 한다
  // (콘텐츠가 자기 배경을 칠하기 전 브라우저 기본 흰색 노출 차단).
  it("paints a dark background on the positioned pane div (no white flash)", () => {
    render(<PaneGrid {...defaultProps} />);
    expect(screen.getByTestId("test-pane-0").style.background).toContain("var(--bg-base)");
  });
});

describe("PaneGrid global terminal startup", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    usePaneRevealStore.setState(usePaneRevealStore.getInitialState());
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());
  });

  const base = {
    testIdFn: (_p: GridPane, i: number) => `test-pane-${i}`,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test-WS",
    containerTestId: "grid",
  };
  const placeholderCount = () =>
    document.querySelectorAll('[data-testid^="pane-loading-placeholder-"]').length;
  const revealedCount = () =>
    Number(screen.getByTestId("grid").getAttribute("data-pane-revealed-count"));

  it("mounts exactly one terminal, then waits for its startup settlement", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: makePanes(3).map((pane) => pane.id),
      eligiblePaneIds: makePanes(3).map((pane) => pane.id),
    });
    act(() => {
      render(<PaneGrid {...base} panes={makePanes(3)} isFocused={() => false} />);
    });
    expect(revealedCount()).toBe(1);
    expect(placeholderCount()).toBe(2);

    act(() => useTerminalStartupStore.getState().settleStartup("pane-0"));

    expect(revealedCount()).toBe(2);
    expect(placeholderCount()).toBe(1);
  });

  it("reveals non-terminal panes immediately without consuming the terminal slot", () => {
    const panes: GridPane[] = [
      ...makePanes(2),
      {
        id: "memo",
        layers: [{ id: "memo", view: { type: "MemoView" } }],
        activeLayerId: "memo",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ];
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["pane-0", "pane-1"],
      eligiblePaneIds: ["pane-0", "pane-1"],
    });
    act(() => {
      render(<PaneGrid {...base} panes={panes} isFocused={() => false} />);
    });
    expect(revealedCount()).toBe(2);
    expect(placeholderCount()).toBe(1);
  });

  it("uses the globally granted focused pane instead of bypassing the slot locally", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: makePanes(8).map((pane) => pane.id),
      eligiblePaneIds: ["pane-7", ...makePanes(7).map((pane) => pane.id)],
    });
    act(() => {
      render(<PaneGrid {...base} panes={makePanes(8)} isFocused={(id) => id === "pane-7"} />);
    });
    expect(document.querySelector('[data-testid="pane-loading-placeholder-7"]')).toBeNull();
    expect(revealedCount()).toBe(1);
  });

  it("does not let an Automation request bypass an already occupied global slot", () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: makePanes(8).map((pane) => pane.id),
      eligiblePaneIds: makePanes(8).map((pane) => pane.id),
    });
    act(() => {
      render(<PaneGrid {...base} panes={makePanes(8)} isFocused={() => false} />);
    });
    expect(document.querySelector('[data-testid="pane-loading-placeholder-7"]')).not.toBeNull();

    let release!: () => void;
    act(() => {
      release = usePaneRevealStore.getState().requestReveal("pane-7");
    });
    expect(document.querySelector('[data-testid="pane-loading-placeholder-7"]')).not.toBeNull();

    act(() => release());
  });
});

describe("PaneGrid restart wiring (ADR-0113)", () => {
  const panes: GridPane[] = [
    {
      id: "pane-0",
      layers: [{ id: "pane-0", view: { type: "TerminalView" } }],
      activeLayerId: "pane-0",
      x: 0,
      y: 0,
      w: 0.5,
      h: 1,
    },
    {
      id: "pane-1",
      layers: [{ id: "pane-1", view: { type: "TerminalView" } }],
      activeLayerId: "pane-1",
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
    },
  ];
  const props = {
    panes,
    testIdFn: (_p: GridPane, i: number) => `test-pane-${i}`,
    isFocused: () => false,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test-WS",
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    usePaneRevealStore.setState(usePaneRevealStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
    // Both terminals mounted at once: startup is normally serialized (ADR-0043)
    // but this suite is about the restart wiring, not the startup queue.
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(panes.map((p) => p.id)) });
    useSettingsStore.setState((s) => ({ controlBar: { ...s.controlBar, defaultMode: "pinned" } }));
  });

  const terminal = (paneId: string) => screen.getByTestId(`mock-terminal-terminal-${paneId}`);

  it("routes the control bar's Restart View through the store", () => {
    render(<PaneGrid {...props} />);
    fireEvent.click(within(screen.getByTestId("test-pane-0")).getByTestId("pane-control-restart"));

    expect(useTerminalRestartStore.getState().requests["pane-0"]).toMatchObject({
      epoch: 1,
      fresh: true,
    });
  });

  // A workspace clear requests the restart from outside the component; the
  // whole point of moving the epoch into a store is that this reaches the view.
  it("marks a pane fresh when the request comes from outside the component", () => {
    render(<PaneGrid {...props} />);
    expect(terminal("pane-0")).toHaveAttribute("data-user-restart", "false");

    act(() => {
      useTerminalRestartStore.getState().requestRestart("pane-0", "/tmp/from-clear");
    });

    expect(terminal("pane-0")).toHaveAttribute("data-user-restart", "true");
    expect(terminal("pane-0")).toHaveAttribute("data-restart-cwd", "/tmp/from-clear");
    // Sibling panes are untouched.
    expect(terminal("pane-1")).toHaveAttribute("data-user-restart", "false");
  });

  it("clears the fresh flag once the view consumes the request", () => {
    render(<PaneGrid {...props} />);
    act(() => {
      useTerminalRestartStore.getState().requestRestart("pane-0");
    });

    act(() => {
      fireEvent.click(terminal("pane-0"));
    });

    expect(useTerminalRestartStore.getState().requests["pane-0"].fresh).toBe(false);
    expect(terminal("pane-0")).toHaveAttribute("data-user-restart", "false");
  });
});

describe("PaneGrid stacked slots (ADR-0297)", () => {
  const stackedSlot = (activeLayerId: string): GridPane => ({
    id: "slot",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    layers: [
      { id: "slot", view: { type: "TerminalView" } },
      { id: "under", view: { type: "TerminalView" } },
    ],
    activeLayerId,
  });

  const props = {
    testIdFn: (_p: GridPane, i: number) => `stack-pane-${i}`,
    isFocused: () => true,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test-WS",
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(["slot", "under"]) });
  });

  it("renders one box per layer, showing only the active layer", () => {
    const { container } = render(<PaneGrid {...props} panes={[stackedSlot("under")]} />);
    const boxes = container.querySelectorAll("[data-layer-id]");
    expect(boxes).toHaveLength(2);
    const active = container.querySelector('[data-layer-id="under"]') as HTMLElement;
    const hidden = container.querySelector('[data-layer-id="slot"]') as HTMLElement;
    expect(active.style.display).toBe("");
    expect(hidden.style.display).toBe("none");
    expect(active.getAttribute("data-testid")).toBe("stack-pane-0");
    expect(hidden.getAttribute("data-testid")).toBeNull();
    expect(screen.getByTestId("mock-terminal-terminal-under")).toBeInTheDocument();
    expect(screen.getByTestId("mock-terminal-terminal-slot")).toBeInTheDocument();
  });

  it("keeps both terminals mounted when the active layer changes", () => {
    const { rerender } = render(<PaneGrid {...props} panes={[stackedSlot("slot")]} />);
    const before = screen.getByTestId("mock-terminal-terminal-under");
    rerender(<PaneGrid {...props} panes={[stackedSlot("under")]} />);
    expect(screen.getByTestId("mock-terminal-terminal-under")).toBe(before);
  });

  it("only the active layer shows the focus indicator", () => {
    render(<PaneGrid {...props} panes={[stackedSlot("under")]} />);
    expect(screen.getAllByTestId("pane-focus-indicator")).toHaveLength(1);
  });

  it("deletes the active layer of a stacked single slot", () => {
    const onRemovePane = vi.fn();
    render(<PaneGrid {...props} panes={[stackedSlot("under")]} onRemovePane={onRemovePane} />);
    fireEvent.mouseEnter(screen.getByTestId("stack-pane-0"));
    fireEvent.click(within(screen.getByTestId("stack-pane-0")).getByTestId("pane-control-delete"));
    expect(onRemovePane).toHaveBeenCalledWith("slot", "under");
  });
});

describe("PaneGrid stack UI (ADR-0297)", () => {
  const single: GridPane = {
    id: "slot",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    layers: [{ id: "slot", view: { type: "TerminalView" } }],
    activeLayerId: "slot",
  };
  const stacked: GridPane = {
    ...single,
    layers: [...single.layers, { id: "under", view: { type: "MemoView" } }],
    activeLayerId: "slot",
  };
  const props = {
    testIdFn: (_p: GridPane, i: number) => `ui-pane-${i}`,
    isFocused: () => false,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test-WS",
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useSettingsStore.setState((s) => ({ controlBar: { ...s.controlBar, defaultMode: "pinned" } }));
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(["slot", "under"]) });
  });

  it("shows the Stack button only when stacking is wired", () => {
    const onStackPane = vi.fn();
    const { rerender } = render(<PaneGrid {...props} panes={[single]} />);
    expect(screen.queryByTestId("pane-control-stack")).toBeNull();
    rerender(<PaneGrid {...props} panes={[single]} onStackPane={onStackPane} />);
    fireEvent.click(screen.getByTestId("pane-control-stack"));
    expect(onStackPane).toHaveBeenCalledWith("slot");
  });

  it("titles the control bar delete as closing a layer only on a stack", () => {
    const { rerender } = render(
      <PaneGrid
        {...props}
        panes={[single, { ...single, id: "other", x: 0.5 }]}
        onRemovePane={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("pane-control-delete")[0].getAttribute("title")).toBe(
      "Delete pane",
    );
    rerender(<PaneGrid {...props} panes={[stacked]} onRemovePane={vi.fn()} />);
    expect(
      within(screen.getByTestId("ui-pane-0"))
        .getByTestId("pane-control-delete")
        .getAttribute("title"),
    ).toBe("Close layer");
  });

  it("renders the strip only for a stacked slot", () => {
    const { rerender } = render(<PaneGrid {...props} panes={[single]} />);
    expect(screen.queryByTestId("pane-stack-strip")).toBeNull();
    rerender(<PaneGrid {...props} panes={[stacked]} />);
    expect(screen.getAllByTestId("pane-stack-strip")).toHaveLength(1);
  });

  it("keeps the terminal mounted when its slot becomes a stack", () => {
    const { rerender } = render(<PaneGrid {...props} panes={[single]} />);
    const before = screen.getByTestId("mock-terminal-terminal-slot");
    rerender(<PaneGrid {...props} panes={[stacked]} />);
    expect(screen.getByTestId("mock-terminal-terminal-slot")).toBe(before);
  });

  it("routes strip actions to the slot callbacks", () => {
    const onActivateLayer = vi.fn();
    const onRemovePane = vi.fn();
    const onStackPane = vi.fn();
    render(
      <PaneGrid
        {...props}
        panes={[stacked]}
        onActivateLayer={onActivateLayer}
        onRemovePane={onRemovePane}
        onStackPane={onStackPane}
      />,
    );
    fireEvent.click(screen.getByTestId("pane-stack-tab-under"));
    expect(onActivateLayer).toHaveBeenCalledWith("slot", "under");
    fireEvent.click(screen.getByTestId("pane-stack-tab-close-under"));
    expect(onRemovePane).toHaveBeenCalledWith("slot", "under");
    fireEvent.click(screen.getByTestId("pane-stack-add"));
    expect(onStackPane).toHaveBeenCalledWith("slot");
  });
});

describe("PaneGrid layer rearrangement (ADR-0297)", () => {
  const makeDataTransfer = () => ({
    data: {} as Record<string, string>,
    types: [] as string[],
    setData(type: string, val: string) {
      this.data[type] = val;
      this.types.push(type);
    },
    getData(type: string) {
      return this.data[type] ?? "";
    },
    effectAllowed: "",
    dropEffect: "",
  });

  const stack: GridPane = {
    id: "A",
    x: 0,
    y: 0,
    w: 0.5,
    h: 1,
    layers: [
      { id: "A", view: { type: "TerminalView" } },
      { id: "a2", view: { type: "TerminalView" } },
      { id: "a3", view: { type: "TerminalView" } },
    ],
    activeLayerId: "A",
  };
  const other: GridPane = {
    id: "B",
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 1,
    layers: [{ id: "B", view: { type: "TerminalView" } }],
    activeLayerId: "B",
  };
  const props = {
    panes: [stack, other],
    testIdFn: (_p: GridPane, i: number) => `re-pane-${i}`,
    isFocused: () => false,
    onPaneFocus: vi.fn(),
    workspaceId: "ws-1",
    workspaceName: "Test-WS",
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useSettingsStore.setState((s) => ({ controlBar: { ...s.controlBar, defaultMode: "pinned" } }));
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(["A", "a2", "a3", "B"]) });
  });

  it("reorders a tab inside its strip", () => {
    const onMoveLayer = vi.fn();
    render(<PaneGrid {...props} onMoveLayer={onMoveLayer} />);
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByTestId("pane-stack-tab-A"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("pane-stack-tab-a3"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("pane-stack-tab-a3"), { dataTransfer });
    // jsdom has no layout, so the pointer counts as the leading half of the tab.
    expect(onMoveLayer).toHaveBeenCalledWith("A", "A", 1);
  });

  it("moves a dragged tab onto another slot", () => {
    const onMoveLayer = vi.fn();
    render(<PaneGrid {...props} onMoveLayer={onMoveLayer} />);
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByTestId("pane-stack-tab-a2"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("re-pane-1"), { dataTransfer });
    expect(screen.getByTestId("pane-stack-drop-target-1")).toBeInTheDocument();
    fireEvent.drop(screen.getByTestId("re-pane-1"), { dataTransfer });
    expect(onMoveLayer).toHaveBeenCalledWith("a2", "B");
  });

  it("does not offer a drop on the own slot body of the dragged tab", () => {
    render(<PaneGrid {...props} onMoveLayer={vi.fn()} />);
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByTestId("pane-stack-tab-a2"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("re-pane-0"), { dataTransfer });
    expect(screen.queryByTestId("pane-stack-drop-target-0")).toBeNull();
  });

  it("merges a slot dropped on the top band of another slot, swaps below it", () => {
    const onMergeSlot = vi.fn();
    const onSwapPanes = vi.fn();
    render(<PaneGrid {...props} onMergeSlot={onMergeSlot} onSwapPanes={onSwapPanes} />);
    const target = screen.getByTestId("re-pane-0");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 0,
      bottom: 700,
      right: 400,
      width: 400,
      height: 600,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const bar = within(screen.getByTestId("re-pane-1")).getByTestId("pane-control-bar");
    // jsdom drag events ignore clientY in the init dict; set it on the event.
    const at = (kind: "dragOver" | "drop", clientY: number, dataTransfer: object) => {
      const event = createEvent[kind](target, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: clientY });
      fireEvent(target, event);
    };

    let dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    at("dragOver", 110, dataTransfer);
    expect(screen.getByTestId("pane-stack-drop-target-0")).toBeInTheDocument();
    at("drop", 110, dataTransfer);
    expect(onMergeSlot).toHaveBeenCalledWith("B", "A");

    dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    at("dragOver", 400, dataTransfer);
    expect(screen.getByTestId("pane-drop-target-0")).toBeInTheDocument();
    at("drop", 400, dataTransfer);
    expect(onSwapPanes).toHaveBeenCalledWith("B", "A");
  });

  /** Gives the box of slot `index` a layout so the merge band can be hit-tested. */
  const layoutBox = (index: number, top: number, height: number) => {
    const box = screen.getByTestId(`re-pane-${index}`);
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({
      top,
      left: 0,
      bottom: top + height,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    return box;
  };
  // jsdom drag events ignore clientY in the init dict; set it on the event.
  const fireAt = (
    el: HTMLElement,
    kind: "dragOver" | "drop",
    clientY: number,
    dataTransfer: object,
  ) => {
    const event = createEvent[kind](el, { dataTransfer });
    Object.defineProperty(event, "clientY", { value: clientY });
    fireEvent(el, event);
    return event;
  };

  it("merges a slot dropped on the strip of an already stacked slot", () => {
    const onMergeSlot = vi.fn();
    const onSwapPanes = vi.fn();
    render(
      <PaneGrid
        {...props}
        onMoveLayer={vi.fn()}
        onMergeSlot={onMergeSlot}
        onSwapPanes={onSwapPanes}
      />,
    );
    const target = layoutBox(0, 100, 600);
    const bar = within(screen.getByTestId("re-pane-1")).getByTestId("pane-control-bar");

    // Pane drop on the strip background bubbles to the box and stacks.
    let dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    fireAt(target, "dragOver", 110, dataTransfer);
    expect(screen.getByTestId("pane-stack-drop-target-0")).toBeInTheDocument();
    fireAt(screen.getByTestId("pane-stack-strip"), "drop", 110, dataTransfer);
    expect(onMergeSlot).toHaveBeenCalledWith("B", "A");

    // Same on a tab inside the strip.
    onMergeSlot.mockClear();
    dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    fireAt(screen.getByTestId("pane-stack-tab-a2"), "dragOver", 110, dataTransfer);
    expect(screen.getByTestId("pane-stack-drop-target-0")).toBeInTheDocument();
    fireAt(screen.getByTestId("pane-stack-tab-a2"), "drop", 110, dataTransfer);
    expect(onMergeSlot).toHaveBeenCalledWith("B", "A");
    expect(onSwapPanes).not.toHaveBeenCalled();
  });

  it("draws the merge band at the hit-tested height on a short slot", () => {
    render(<PaneGrid {...props} onMergeSlot={vi.fn()} onSwapPanes={vi.fn()} />);
    const target = layoutBox(0, 100, 60);
    const bar = within(screen.getByTestId("re-pane-1")).getByTestId("pane-control-bar");
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    // 60px tall → band is min(40, 60/3) = 20px.
    fireAt(target, "dragOver", 110, dataTransfer);
    expect(screen.getByText("Stack here")).toHaveStyle({ height: "20px" });
  });

  it("draws the full merge band on a tall slot", () => {
    render(<PaneGrid {...props} onMergeSlot={vi.fn()} onSwapPanes={vi.fn()} />);
    const target = layoutBox(0, 100, 600);
    const bar = within(screen.getByTestId("re-pane-1")).getByTestId("pane-control-bar");
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(bar, { dataTransfer });
    fireAt(target, "dragOver", 110, dataTransfer);
    expect(screen.getByText("Stack here")).toHaveStyle({ height: "40px" });
  });

  it("splits a layer out from the tab context menu", () => {
    const onExtractLayer = vi.fn();
    render(<PaneGrid {...props} onExtractLayer={onExtractLayer} />);
    fireEvent.contextMenu(screen.getByTestId("pane-stack-tab-a2"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("pane-stack-menu-split-right"));
    expect(onExtractLayer).toHaveBeenCalledWith("a2", "vertical");
    expect(screen.queryByTestId("pane-stack-menu")).toBeNull();

    fireEvent.contextMenu(screen.getByTestId("pane-stack-tab-a3"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("pane-stack-menu-split-down"));
    expect(onExtractLayer).toHaveBeenCalledWith("a3", "horizontal");
  });

  it("closes the tab menu on Escape", () => {
    render(<PaneGrid {...props} onExtractLayer={vi.fn()} />);
    fireEvent.contextMenu(screen.getByTestId("pane-stack-tab-a2"), { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("pane-stack-menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("pane-stack-menu")).toBeNull();
  });
});
