import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileExplorerView } from "./FileExplorerView";
import {
  clipboardWriteText,
  listDirectory,
  getHomeDirectory,
  handleLxMessage,
} from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useCwdPropagateStore } from "@/stores/cwd-propagate-store";

// --- Mocks ---

let cwdCallback: ((data: { terminalId: string; cwd: string; cwdSend?: boolean }) => void) | null =
  null;
let syncCwdCallback:
  | ((data: {
      path: string;
      terminalId: string;
      groupId: string;
      targets: string[];
      force?: boolean;
    }) => void)
  | null = null;

vi.mock("@/lib/tauri-api", () => ({
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockResolvedValue([]),
  getHomeDirectory: vi.fn().mockResolvedValue("/home/fallback"),
  onTerminalCwdChanged: vi
    .fn()
    .mockImplementation(
      (cb: (data: { terminalId: string; cwd: string; cwdSend?: boolean }) => void) => {
        cwdCallback = cb;
        return Promise.resolve(vi.fn());
      },
    ),
  onSyncCwd: vi
    .fn()
    .mockImplementation(
      (
        cb: (data: {
          path: string;
          terminalId: string;
          groupId: string;
          targets: string[];
          force?: boolean;
        }) => void,
      ) => {
        syncCwdCallback = cb;
        return Promise.resolve(vi.fn());
      },
    ),
  handleLxMessage: vi.fn().mockResolvedValue({ success: true, error: null }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const defaultProps = {
  instanceId: "file-explorer-test-1",
  profile: "WSL",
  syncGroup: "ws-1",
  cwdReceive: true,
  isFocused: true,
  lastCwd: "/home/user",
};

/** Mock directory entries for testing. */
const mockDirEntries = [
  { name: "subdir", isDirectory: true, isSymlink: false, isExecutable: false, size: 0 },
  { name: "a.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 100 },
  { name: "b.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 200 },
  { name: "c.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 300 },
];

function mockListDir(entries = mockDirEntries) {
  vi.mocked(listDirectory).mockResolvedValue(entries);
}

describe("FileExplorerView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cwdCallback = null;
    syncCwdCallback = null;
    useCwdPropagateStore.setState({ requests: {} });
    vi.mocked(handleLxMessage).mockClear();
    vi.mocked(clipboardWriteText).mockClear();
    vi.mocked(listDirectory).mockClear();
    vi.mocked(getHomeDirectory).mockClear();
    vi.mocked(getHomeDirectory).mockResolvedValue("/home/fallback");
    mockListDir();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState({ instances: [] });
    useFileViewerStore.setState({ open: false, path: "", maximized: false });
    // jsdom doesn't implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with data-testid", async () => {
    render(<FileExplorerView {...defaultProps} />);
    expect(screen.getByTestId("file-explorer-view")).toBeInTheDocument();
  });

  it("shows path bar with current cwd", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(screen.getByTestId("file-explorer-path-bar")).toHaveTextContent("/home/user");
  });

  it("calls listDirectory and shows entries", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user");
    // item-0 is "..", then actual entries
    expect(screen.getByTestId("file-explorer-item-0")).toHaveTextContent("..");
    expect(screen.getByTestId("file-explorer-item-1")).toHaveTextContent("subdir/");
    expect(screen.getByTestId("file-explorer-item-2")).toHaveTextContent("a.txt");
    expect(screen.getByTestId("file-explorer-item-3")).toHaveTextContent("b.txt");
    expect(screen.getByTestId("file-explorer-item-4")).toHaveTextContent("c.txt");
  });

  it("click selects single item", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("file-explorer-item-1"));
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("false");
  });

  it("ctrl+click toggles selection", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("file-explorer-item-0"));
    fireEvent.click(screen.getByTestId("file-explorer-item-2"), { ctrlKey: true });
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("false");
  });

  it("shift+click selects range", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("file-explorer-item-1"));
    fireEvent.click(screen.getByTestId("file-explorer-item-3"), { shiftKey: true });
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("false");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-3").dataset.selected).toBe("true");
  });

  it("arrow down moves focus", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "ArrowDown" });
    expect(screen.getByTestId("file-explorer-item-1").dataset.focused).toBe("true");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
  });

  it("arrow up moves focus", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowUp" });
    expect(screen.getByTestId("file-explorer-item-1").dataset.focused).toBe("true");
  });

  it("Enter activates directory (navigates)", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    const view = screen.getByTestId("file-explorer-view");
    // Focus is on index 0 (..); move to index 1 (subdir), press Enter
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "Enter" });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("Enter activates file (opens shared viewer overlay)", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("file-explorer-view");
    // Move to a.txt (index 2: past ".." and "subdir")
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "Enter" });

    // Opening a file delegates to the global file-viewer store (#277/#279),
    // not an inline pane viewer.
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/home/user/a.txt");
  });

  it("double-click directory navigates", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1")); // subdir (index 1, after "..")

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("double-click file opens shared viewer overlay", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-2")); // a.txt (index 2)

    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/home/user/a.txt");
  });

  it("Ctrl+C copies selected paths", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("file-explorer-item-2")); // a.txt (index 2)
    fireEvent.click(screen.getByTestId("file-explorer-item-4"), { ctrlKey: true }); // c.txt (index 4)

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.copy(view);

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt\n/home/user/c.txt");
  });

  it("right-click copies selected paths", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("file-explorer-item-2")); // a.txt (index 2)
    vi.mocked(clipboardWriteText).mockClear();

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.contextMenu(view);

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt");
  });

  it("terminal CWD change event refreshes listing", async () => {
    // Register a terminal in the syncGroup so the event handler can match it
    useTerminalStore.getState().registerInstance({
      id: "terminal-1",
      profile: "WSL",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });

    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    // Simulate terminal CWD change event
    act(() => {
      cwdCallback?.({ terminalId: "terminal-1", cwd: "/home/user/other" });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/other");
  });

  it("ignores terminal CWD change when source has cwdSend=false", async () => {
    // Register a terminal in the syncGroup
    useTerminalStore.getState().registerInstance({
      id: "terminal-1",
      profile: "WSL",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });

    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    // Simulate terminal CWD change event with cwdSend=false
    act(() => {
      cwdCallback?.({ terminalId: "terminal-1", cwd: "/home/user/other", cwdSend: false });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // listDirectory should NOT be called because source terminal has cwdSend disabled
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("accepts terminal CWD change when source has cwdSend=true", async () => {
    // Register a terminal in the syncGroup
    useTerminalStore.getState().registerInstance({
      id: "terminal-1",
      profile: "WSL",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });

    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    // Simulate terminal CWD change event with cwdSend=true (explicit)
    act(() => {
      cwdCallback?.({ terminalId: "terminal-1", cwd: "/home/user/other", cwdSend: true });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // listDirectory SHOULD be called because cwdSend is true
    expect(listDirectory).toHaveBeenCalledWith("/home/user/other");
  });

  // ── 1회성 CWD 전파 (issue #293, #375) ──

  it("ignores a force sync-cwd event when cwdReceive is off (issue #375)", async () => {
    // 평소 수신을 꺼둔 file explorer(또는 dock pane)는 force 1회 전파에도 따라오면 안 된다.
    // CWD 전파는 force 여부와 무관하게 각 대상의 cwdReceive 의사를 존중해야 한다.
    render(<FileExplorerView {...defaultProps} cwdReceive={false} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    act(() => {
      syncCwdCallback?.({
        path: "/home/user/forced",
        terminalId: "terminal-source",
        groupId: "ws-1",
        targets: [],
        force: true,
      });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("follows a force sync-cwd event when cwdReceive is on", async () => {
    // 수신을 켜둔 대상은 force 1회 전파를 받아야 한다.
    render(<FileExplorerView {...defaultProps} cwdReceive={true} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    act(() => {
      syncCwdCallback?.({
        path: "/home/user/forced",
        terminalId: "terminal-source",
        groupId: "ws-1",
        targets: [],
        force: true,
      });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/forced");
  });

  it("ignores a non-force sync-cwd event (handled by terminal-cwd-changed path)", async () => {
    render(<FileExplorerView {...defaultProps} cwdReceive={false} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    act(() => {
      syncCwdCallback?.({
        path: "/home/user/normal",
        terminalId: "terminal-source",
        groupId: "ws-1",
        targets: [],
        force: false,
      });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("ignores a force sync-cwd event from a different sync group", async () => {
    render(<FileExplorerView {...defaultProps} cwdReceive={true} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    act(() => {
      syncCwdCallback?.({
        path: "/home/user/elsewhere",
        terminalId: "terminal-source",
        groupId: "other-group",
        targets: [],
        force: true,
      });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("dispatches a force sync-cwd as source when propagate is requested", async () => {
    render(<FileExplorerView {...defaultProps} paneId="pane-fe" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(handleLxMessage).mockClear();

    // 컨트롤 바 버튼이 호출하는 것과 동일한 요청.
    act(() => {
      useCwdPropagateStore.getState().requestPropagate("pane-fe");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(handleLxMessage).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(vi.mocked(handleLxMessage).mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      action: "sync-cwd",
      path: "/home/user",
      terminal_id: "file-explorer-test-1",
      group_id: "ws-1",
      force: true,
    });
  });

  it("retries a propagate request that was clicked before syncGroup was ready (#296 P3-b)", async () => {
    // 준비 전(syncGroup 미확정) 클릭은 유실되지 않고, syncGroup 이 채워지면 자동 재시도돼야 한다.
    const { rerender } = render(
      <FileExplorerView {...defaultProps} paneId="pane-fe" syncGroup="" lastCwd="/home/user" />,
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(handleLxMessage).mockClear();

    // syncGroup 이 아직 비어 있을 때 버튼 클릭.
    act(() => {
      useCwdPropagateStore.getState().requestPropagate("pane-fe");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    // 준비 전이므로 dispatch 되지 않아야 한다(가드가 ref advance 보다 앞).
    expect(handleLxMessage).not.toHaveBeenCalled();

    // 이제 syncGroup 이 채워진다 → effect 재실행 → 동일 클릭이 자동 재시도된다.
    rerender(
      <FileExplorerView {...defaultProps} paneId="pane-fe" syncGroup="ws-1" lastCwd="/home/user" />,
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(handleLxMessage).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(vi.mocked(handleLxMessage).mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      action: "sync-cwd",
      path: "/home/user",
      terminal_id: "file-explorer-test-1",
      group_id: "ws-1",
      force: true,
    });
  });

  it("dispatches a propagate request that was clicked before cwd resolved (#296 P1)", async () => {
    // 마운트 직후 syncGroup 은 준비됐지만 cwd 만 home 으로 비동기 로딩 중인 흔한 상황.
    // 이때 누른 클릭은 가드에서 보존되며, cwd 가 채워지면 자동으로 1회 dispatch 돼야 한다.
    // home 해소 시점을 제어하기 위해 deferred promise 를 쓴다.
    let resolveHome: ((value: string) => void) | null = null;
    vi.mocked(getHomeDirectory).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveHome = resolve;
        }),
    );

    // lastCwd 없음 + syncGroup 의 cwd 보유 터미널 없음 → cwd 는 home 로딩 대기 상태.
    render(<FileExplorerView {...defaultProps} paneId="pane-fe" syncGroup="ws-1" lastCwd="" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(handleLxMessage).mockClear();

    // cwd 가 아직 비어 있을 때 버튼 클릭.
    act(() => {
      useCwdPropagateStore.getState().requestPropagate("pane-fe");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    // cwd 미확정이므로 dispatch 되지 않아야 한다(가드가 ref advance 보다 앞).
    expect(handleLxMessage).not.toHaveBeenCalled();

    // 이제 home 이 해소된다 → setCurrentCwd → effect 재실행(currentCwd dep) → 자동 재시도.
    await act(async () => {
      resolveHome?.("/home/fallback");
      await vi.runAllTimersAsync();
    });

    expect(handleLxMessage).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(vi.mocked(handleLxMessage).mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      action: "sync-cwd",
      path: "/home/fallback",
      terminal_id: "file-explorer-test-1",
      group_id: "ws-1",
      force: true,
    });
  });

  it("does not dispatch a propagate on plain navigation cwd changes (#296 P1)", async () => {
    // currentCwd 가 deps 에 추가됐어도, 정상 navigation(propagateRequest 미증가)은
    // lastHandledRequestRef 게이트가 막아 dispatch 되지 않아야 한다.
    mockListDir(mockDirEntries);
    render(
      <FileExplorerView {...defaultProps} paneId="pane-fe" syncGroup="ws-1" lastCwd="/home/user" />,
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(handleLxMessage).mockClear();

    // 하위 디렉터리로 navigation(더블클릭) → currentCwd 변경. item-1 은 "subdir"(디렉터리).
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // navigation 은 전파 요청을 올리지 않으므로 force sync-cwd 가 발사되면 안 된다.
    const propagateCalls = vi.mocked(handleLxMessage).mock.calls.filter((c) => {
      try {
        const p = JSON.parse(c[0] as string);
        return p.action === "sync-cwd" && p.force === true;
      } catch {
        return false;
      }
    });
    expect(propagateCalls).toHaveLength(0);
  });

  it("falls back to home directory when no CWD available (#274)", async () => {
    // No lastCwd, no syncGroup terminal with cwd, cwdReceive off:
    // explorer must NOT be stuck at "..." / "Empty directory" — it falls back to home.
    render(<FileExplorerView {...defaultProps} lastCwd="" syncGroup="" cwdReceive={false} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(getHomeDirectory).toHaveBeenCalled();
    // Path bar shows the resolved home dir, not "..."
    expect(screen.getByTestId("file-explorer-path-bar")).toHaveTextContent("/home/fallback");
    // Directory listing was fetched for the home dir
    expect(listDirectory).toHaveBeenCalledWith("/home/fallback");
    expect(screen.getByTestId("file-explorer-list")).toBeInTheDocument();
  });

  it("does not call home fallback when a CWD is available", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(getHomeDirectory).not.toHaveBeenCalled();
    expect(listDirectory).toHaveBeenCalledWith("/home/user");
  });

  it("shows .. entry at top of file list", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // First item should be ".."
    expect(screen.getByTestId("file-explorer-item-0")).toHaveTextContent("..");
    // Original first entry (subdir) is now at index 1
    expect(screen.getByTestId("file-explorer-item-1")).toHaveTextContent("subdir/");
  });

  it("double-click .. navigates to parent directory", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0")); // ".."

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home");
  });

  it("back button navigates to previous directory", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir (double-click item-1 which is subdir after ".." at 0)
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.mocked(listDirectory).mockClear();
    // Click back button
    fireEvent.click(screen.getByTestId("file-explorer-back"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user");
  });

  it("forward button navigates after going back", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Go back
    fireEvent.click(screen.getByTestId("file-explorer-back"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.mocked(listDirectory).mockClear();
    // Go forward
    fireEvent.click(screen.getByTestId("file-explorer-forward"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("mouse back button goes back, forward button goes forward", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("file-explorer-view");
    vi.mocked(listDirectory).mockClear();

    // Mouse button 3 = back
    fireEvent.mouseDown(view, { button: 3 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(listDirectory).toHaveBeenCalledWith("/home/user");

    vi.mocked(listDirectory).mockClear();
    // Mouse button 4 = forward
    fireEvent.mouseDown(view, { button: 4 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("Backspace navigates to parent", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "Backspace" });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home");
  });

  it("opening a file with a configured extension viewer still opens the shared overlay", async () => {
    // The extension→command resolution now lives in the shared FileViewer; the
    // explorer simply opens the overlay with the file path regardless.
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".txt"], command: "vi", profile: "WSL" }],
      },
    });

    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-2")); // a.txt

    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/home/user/a.txt");
  });
});
