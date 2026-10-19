import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeView } from "./WorktreeView";
import { useOverridesStore } from "@/stores/overrides-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import type { WorktreeEntry, WorktreeInspection, WorktreeSnapshot } from "@/lib/worktree-api";

const api = vi.hoisted(() => ({
  getWorktreeSnapshot: vi.fn(),
  inspectWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  useSyncGroupCwdContext: vi.fn(),
  clipboardWriteText: vi.fn(),
  focusWorktreeUsage: vi.fn(),
  openWorktreeTerminal: vi.fn(),
  useContainerSize: vi.fn(),
}));
vi.mock("@/lib/worktree-api", () => api);
vi.mock("@/hooks/useSyncGroupCwd", () => api);
vi.mock("@/lib/tauri-api", () => ({ clipboardWriteText: api.clipboardWriteText }));
vi.mock("@/lib/worktree-navigation", () => api);
vi.mock("@/hooks/useContainerSize", () => api);

function entry(path: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path,
    head: "abc123",
    branch: "feature",
    isMain: false,
    bare: false,
    usage: [],
    ...overrides,
  };
}
function inspection(
  worktree: WorktreeEntry,
  overrides: Partial<WorktreeInspection> = {},
): WorktreeInspection {
  return {
    worktree,
    trackedChanges: 0,
    untrackedFiles: 0,
    ignoredFiles: 0,
    files: [],
    filesTruncated: false,
    blockers: [],
    canRemove: true,
    usage: worktree.usage,
    ...overrides,
  };
}
const clean = entry("D:/repo-clean");
const main = entry("D:/repo", { isMain: true, branch: "main" });
function snapshot(worktrees = [main, clean]): WorktreeSnapshot {
  return { workingDir: "D:/repo", repositoryPath: "D:/repo", commonDir: "D:/repo/.git", worktrees };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function openDetails() {
  const [branch] = await screen.findAllByText("feature");
  const row = branch.closest<HTMLElement>("[data-worktree-path]")!;
  fireEvent.click(within(row).getByRole("button", { name: "상세", exact: true }));
}
function renderView() {
  return render(<WorktreeView instanceId="worktree-pane" paneId="pane" syncGroup="ws" />);
}

describe("WorktreeView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.useContainerSize.mockReturnValue({ w: 240, h: 452 });
    api.useSyncGroupCwdContext.mockReturnValue({
      cwd: "D:/repo",
      sourceTerminalId: "terminal-source",
    });
    api.getWorktreeSnapshot.mockResolvedValue(snapshot());
    api.inspectWorktree.mockImplementation((_cwd, path) =>
      Promise.resolve(
        inspection(
          path === main.path ? main : clean,
          path === main.path ? { blockers: ["main"], canRemove: false } : {},
        ),
      ),
    );
    api.removeWorktree.mockResolvedValue(undefined);
    api.clipboardWriteText.mockResolvedValue(undefined);
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useTerminalStore.setState({ instances: [] });
    useWorkspaceStore.setState({
      workspaces: [],
      workspaceDisplayOrder: [],
      activeWorkspaceId: "ws-a",
    });
    useTerminalDisplayStore.setState({ contexts: {} });
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState({ hiddenWorkspaceIds: new Set() });
    useNotificationStore.setState({ notifications: [] });
    useGridStore.setState({ focusedPaneIndex: 0 });
    useDockStore.setState({ focusedDock: null, focusedDockPaneId: null });
  });

  it("바깥 목록 행은 상세로 진입하지 않고 별도 상세 버튼을 제공한다", async () => {
    renderView();
    await screen.findByText("feature");
    const row = document.querySelector<HTMLElement>(`[data-worktree-path="${clean.path}"]`)!;
    fireEvent.click(row);
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "상세", exact: true }));
    expect(await screen.findByTestId("worktree-detail")).toBeInTheDocument();
  });

  it("터미널 한 개는 바깥 목록에서 상세를 열지 않고 바로 이동한다", async () => {
    const usage = {
      terminalId: "terminal-a",
      paneId: "a",
      workspaceId: "ws-a",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "live" as const,
      agentType: "claude",
    };
    const linked = { ...clean, usage: [usage] };
    api.getWorktreeSnapshot.mockResolvedValue(snapshot([linked]));
    api.inspectWorktree.mockResolvedValue(
      inspection(linked, { canRemove: false, blockers: ["in_use"] }),
    );
    api.focusWorktreeUsage.mockReturnValue(true);
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-a",
          name: "개발",
          panes: [
            {
              id: "slot-a",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              layers: [{ id: "a", view: { type: "TerminalView" } }],
              activeLayerId: "a",
            },
          ],
        },
      ],
    });
    renderView();
    const move = await screen.findByRole("button", { name: "터미널로 이동", exact: true });
    expect(within(move).getByText("Claude")).toBeInTheDocument();
    expect(within(move).getByText("개발")).toBeInTheDocument();
    expect(within(move).queryByText("pane 1")).not.toBeInTheDocument();
    expect(move).toHaveAttribute("title", expect.stringContaining("pane 1"));
    expect(screen.getAllByText("Claude")).toHaveLength(1);
    expect(move.querySelector('[data-testid="pane-minimap"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "터미널 1개" })).not.toBeInTheDocument();
    fireEvent.click(move);
    expect(api.focusWorktreeUsage).toHaveBeenCalledWith(usage);
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
  });

  it("터미널 여러 개도 첫 pane으로 바로 이동하고 별도 화살표에서 대상을 선택한다", async () => {
    const usage = ["claude", "codex", null].map((agentType, i) => ({
      terminalId: `terminal-${i}`,
      paneId: `p-${i}`,
      workspaceId: "ws-a",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "live" as const,
      agentType,
    }));
    const linked = { ...clean, usage };
    api.getWorktreeSnapshot.mockResolvedValue(snapshot([linked]));
    api.inspectWorktree.mockResolvedValue(
      inspection(linked, {
        canRemove: false,
        blockers: ["in_use", "ignored_files"],
        ignoredFiles: 21097,
      }),
    );
    api.focusWorktreeUsage.mockReturnValue(true);
    renderView();
    const select = await screen.findByRole("button", { name: "터미널 3개", exact: true });
    const move = screen.getByRole("button", { name: "터미널로 이동", exact: true });
    expect(within(move).getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(await screen.findByText("무시 21097")).toBeInTheDocument();
    fireEvent.click(move);
    expect(api.focusWorktreeUsage).toHaveBeenCalledWith(usage[0]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    api.focusWorktreeUsage.mockClear();
    fireEvent.click(select);
    expect(api.focusWorktreeUsage).not.toHaveBeenCalled();
    const menu = await screen.findByRole("menu", { name: "터미널 선택" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Codex/ }));
    expect(api.focusWorktreeUsage).toHaveBeenCalledWith(usage[1]);
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
  });

  it("터미널이 없으면 바깥 목록의 새 터미널 버튼으로 생성한다", async () => {
    api.openWorktreeTerminal.mockReturnValue("new-pane");
    renderView();
    await screen.findByText("feature");
    const row = document.querySelector<HTMLElement>(`[data-worktree-path="${clean.path}"]`)!;
    fireEvent.click(within(row).getByRole("button", { name: "새 터미널", exact: true }));
    expect(api.openWorktreeTerminal).toHaveBeenCalledWith(clean.path, "pane");
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
  });

  it("같은 workspace의 선택지는 포커스된 slot의 활성 layer 하나만 강조한다", async () => {
    const usage = ["back", "front", "right"].map((paneId) => ({
      terminalId: `terminal-${paneId}`,
      paneId,
      workspaceId: "ws-a",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "live" as const,
      agentType: null,
    }));
    const linked = { ...clean, usage };
    api.getWorktreeSnapshot.mockResolvedValue(snapshot([linked]));
    api.inspectWorktree.mockResolvedValue(
      inspection(linked, { canRemove: false, blockers: ["in_use"] }),
    );
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-a",
          name: "개발",
          panes: [
            {
              id: "left-slot",
              x: 0,
              y: 0,
              w: 0.5,
              h: 1,
              layers: [
                { id: "back", view: { type: "TerminalView" } },
                { id: "front", view: { type: "TerminalView" } },
              ],
              activeLayerId: "front",
            },
            {
              id: "right-slot",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              layers: [{ id: "right", view: { type: "TerminalView" } }],
              activeLayerId: "right",
            },
          ],
        },
      ],
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "터미널 3개", exact: true }));
    const menu = screen.getByRole("menu", { name: "터미널 선택" });
    const items = within(menu).getAllByRole("menuitem");
    const nameColor = (item: HTMLElement) =>
      item.querySelector<HTMLElement>(".workspace-identity > span:last-child")!.style.color;
    expect(items.map(nameColor)).toEqual([
      "var(--text-secondary)",
      "var(--text-primary)",
      "var(--text-secondary)",
    ]);
    expect(items[1]).toHaveAttribute("aria-current", "true");
    expect(menu.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    act(() => useGridStore.setState({ focusedPaneIndex: 1 }));
    expect(items.map(nameColor)).toEqual([
      "var(--text-secondary)",
      "var(--text-secondary)",
      "var(--text-primary)",
    ]);
    expect(items[2]).toHaveAttribute("aria-current", "true");
    act(() => useGridStore.setState({ focusedPaneIndex: null }));
    expect(items.map(nameColor)).toEqual(Array(3).fill("var(--text-secondary)"));
    expect(menu.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  it("저장된 pane도 selector의 표시 순서·미니맵 위치·이전 표시 맥락을 따른다", async () => {
    const usage = {
      terminalId: "terminal-a",
      paneId: "a",
      workspaceId: "ws-a",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "saved" as const,
      agentType: null,
    };
    const linked = { ...clean, usage: [usage] };
    api.getWorktreeSnapshot.mockResolvedValue(snapshot([linked]));
    api.inspectWorktree.mockResolvedValue(
      inspection(linked, { canRemove: false, blockers: ["in_use"] }),
    );
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-a",
          name: "개발",
          panes: [
            {
              id: "right",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              layers: [{ id: "empty", view: { type: "EmptyView" } }],
              activeLayerId: "empty",
            },
            {
              id: "left",
              x: 0,
              y: 0,
              w: 0.5,
              h: 1,
              layers: [
                { id: "a", view: { type: "TerminalView", profile: "WSL", lastCwd: clean.path } },
              ],
              activeLayerId: "a",
            },
          ],
        },
        { id: "ws-hidden", name: "숨김", panes: [] },
        { id: "ws-b", name: "다른 작업", panes: [] },
      ],
      workspaceDisplayOrder: ["ws-hidden", "ws-b", "ws-a"],
    });
    useUiStore.setState({ hiddenWorkspaceIds: new Set(["ws-hidden"]) });
    useTerminalDisplayStore.setState({
      contexts: {
        "terminal-a": {
          version: 1,
          profile: "WSL",
          activity: { type: "interactiveApp", name: "Codex" },
          branch: "saved-branch",
        },
      },
    });
    renderView();
    const move = await screen.findByRole("button", { name: "터미널로 이동", exact: true });
    expect(move.querySelector(".workspace-identity > span:first-child")).toHaveTextContent("2");
    expect(within(move).getByText("WSL")).toBeInTheDocument();
    expect(within(move).getByText("Codex")).toBeInTheDocument();
    expect(within(move).getByText("saved-branch")).toBeInTheDocument();
    expect(move.querySelector('[data-pane-index="1"]')).toHaveAttribute("data-highlighted", "true");
    expect(move).toHaveAttribute("title", expect.stringContaining("저장된 세션"));
    act(() => useWorkspaceStore.setState({ workspaceDisplayOrder: ["ws-a", "ws-b", "ws-hidden"] }));
    expect(move.querySelector(".workspace-identity > span:first-child")).toHaveTextContent("1");
  });

  it("디렉터리 상태는 둘째 줄에, 에이전트 상태는 이동 버튼에 표시한다", async () => {
    const usage = {
      terminalId: "terminal-live",
      paneId: "live",
      workspaceId: "ws",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "live" as const,
      agentType: "codex",
    };
    const linked = { ...clean, usage: [usage] };
    api.getWorktreeSnapshot.mockResolvedValue(snapshot([linked]));
    api.inspectWorktree.mockResolvedValue(
      inspection(linked, {
        trackedChanges: 300,
        canRemove: false,
        blockers: ["tracked_changes", "in_use"],
      }),
    );
    useTerminalStore.setState({
      instances: [
        {
          id: "terminal-live",
          sessionReady: true,
          activity: { type: "interactiveApp", name: "Claude" },
          task: { state: "running", observation: "confirmed", observedAt: Date.now() },
        } as never,
      ],
    });
    renderView();
    const move = await screen.findByRole("button", { name: "터미널로 이동", exact: true });
    expect(within(move).getByText("Claude")).toBeInTheDocument();
    expect(move.querySelector('[data-status-icon="working"]')).toBeInTheDocument();
    expect(await screen.findByText("변경 300")).toBeInTheDocument();
    expect(screen.queryByText("laymux 연결")).not.toBeInTheDocument();
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
  });

  it("갱신 중 기존 목록·선택은 유지하고 이전 제거 확인은 사용할 수 없다", async () => {
    renderView();
    await openDetails();
    fireEvent.click(await screen.findByRole("button", { name: "워크트리 제거" }));
    const pending = deferred<WorktreeSnapshot>();
    api.getWorktreeSnapshot.mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "워크트리 새로고침" }));
    expect(document.querySelector(`[data-worktree-path="${clean.path}"]`)).toBeInTheDocument();
    expect(screen.getByTestId("worktree-detail")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "제거 확인" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /정리 후보.*검사/ })).toBeInTheDocument();
    await act(async () => pending.resolve(snapshot()));
  });

  it("상세에서 목록으로 복귀하면 이전 탐색 위치를 유지한다", async () => {
    renderView();
    await screen.findByText("feature");
    const list = screen.getByTestId("worktree-list");
    list.scrollTop = 240;
    fireEvent.scroll(list);
    await openDetails();
    await screen.findByTestId("worktree-detail");
    fireEvent.click(screen.getByRole("button", { name: "목록으로 돌아가기" }));
    expect(list.scrollTop).toBe(240);
  });

  it("목록 갱신 실패는 이전 상세를 유지하며 제거를 막고 검사 중 상태를 끝낸다", async () => {
    renderView();
    await openDetails();
    await screen.findByTestId("worktree-detail-summary");
    api.getWorktreeSnapshot.mockRejectedValue(new Error("저장소 접근 실패"));
    fireEvent.click(screen.getByRole("button", { name: "워크트리 새로고침" }));
    await waitFor(() =>
      expect(screen.getByTestId("view-worktree")).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByTestId("worktree-detail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "워크트리 제거" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "워크트리 제거" })).toHaveAttribute(
      "title",
      expect.stringContaining("실패"),
    );
    expect(screen.queryByRole("button", { name: /정리 후보.*검사 중/ })).not.toBeInTheDocument();
  });

  it("생성 중 적격성을 즉시 보류하고 실제 세션 준비 후 사용 정보를 갱신한다", async () => {
    api.openWorktreeTerminal.mockReturnValue("created");
    renderView();
    await openDetails();
    await screen.findByTestId("worktree-detail-summary");
    fireEvent.click(screen.getByRole("button", { name: "새 터미널" }));
    expect(screen.getByRole("button", { name: "워크트리 제거" })).toBeDisabled();
    api.inspectWorktree.mockResolvedValue(
      inspection(clean, { canRemove: false, blockers: ["in_use"] }),
    );
    const calls = api.getWorktreeSnapshot.mock.calls.length;
    act(() =>
      useTerminalStore.setState({
        instances: [{ id: "terminal-created", sessionReady: true } as never],
      }),
    );
    await waitFor(() => expect(api.getWorktreeSnapshot.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "워크트리 제거" })).toHaveAttribute(
        "title",
        expect.stringContaining("사용 중"),
      ),
    );
    expect(screen.getByTestId("worktree-detail")).toBeInTheDocument();
    act(() => useTerminalStore.setState({ instances: [] }));
    expect(screen.queryByText("터미널 시작을 확인하고 있습니다")).not.toBeInTheDocument();
  });

  it("완료된 검사만 정리 후보에 포함하고 제거는 상세 검사와 명시적 확인 뒤 실행한다", async () => {
    renderView();
    await screen.findByText("feature");
    fireEvent.click(screen.getByRole("button", { name: /^정리 후보 \d+/ }));
    await waitFor(() => expect(screen.queryByText("main")).not.toBeInTheDocument());
    await openDetails();
    const detail = await screen.findByTestId("worktree-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "워크트리 제거" }));
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(within(detail).getByText(/브랜치는 유지/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "제거 확인" }));
    await waitFor(() =>
      expect(api.removeWorktree).toHaveBeenCalledWith("D:/repo", clean.path, clean.head),
    );
  });

  it("별도 저장소 핀 없이 pane의 CWD 수신 설정과 초기 경로를 사용한다", async () => {
    render(
      <WorktreeView
        instanceId="worktree-pane"
        paneId="pane"
        syncGroup="ws"
        cwdReceive={false}
        repositoryPath="D:/repo"
      />,
    );
    await screen.findByText("feature");
    expect(screen.queryByRole("button", { name: /저장소 고정/ })).not.toBeInTheDocument();
    expect(api.useSyncGroupCwdContext).toHaveBeenCalledWith({
      instanceId: "worktree-pane",
      syncGroup: "ws",
      cwdReceive: false,
      initialCwd: "D:/repo",
    });
  });

  it("상세 재검사에서 사용 중인 터미널이 발견되면 제거를 막고 연결 정보를 보여준다", async () => {
    const usage = {
      terminalId: "terminal-a",
      paneId: "a",
      workspaceId: "ws-a",
      workspaceName: "개발",
      cwd: clean.path,
      kind: "live" as const,
      agentType: "codex",
    };
    api.inspectWorktree.mockResolvedValue(
      inspection(clean, { usage: [usage], blockers: ["in_use"], canRemove: false }),
    );
    renderView();
    await openDetails();
    const detail = await screen.findByTestId("worktree-detail");
    expect(within(detail).getByRole("button", { name: "워크트리 제거" })).toBeDisabled();
    fireEvent.click(within(detail).getByRole("button", { name: /개발.*Codex/ }));
    expect(api.focusWorktreeUsage).toHaveBeenCalledWith(usage);
  });

  it("CWD 변경은 이전 선택과 제거 확인을 즉시 해제하고 늦은 검사 결과를 버린다", async () => {
    const view = renderView();
    await openDetails();
    const detail = await screen.findByTestId("worktree-detail");
    fireEvent.click(within(detail).getByRole("button", { name: "워크트리 제거" }));
    const next = deferred<WorktreeSnapshot>();
    api.getWorktreeSnapshot.mockReturnValue(next.promise);
    api.useSyncGroupCwdContext.mockReturnValue({
      cwd: "D:/other",
      sourceTerminalId: "terminal-source",
    });
    view.rerender(<WorktreeView instanceId="worktree-pane" paneId="pane" syncGroup="ws" />);
    expect(screen.queryByTestId("worktree-detail")).not.toBeInTheDocument();
    expect(screen.queryByText("feature")).not.toBeInTheDocument();
    await act(async () => next.resolve({ ...snapshot([]), repositoryPath: "D:/other" }));
    expect(api.removeWorktree).not.toHaveBeenCalled();
  });

  it("이전 저장소의 늦은 목록 응답이 현재 저장소를 덮어쓰지 않는다", async () => {
    const old = deferred<WorktreeSnapshot>();
    api.getWorktreeSnapshot.mockReturnValueOnce(old.promise);
    const view = renderView();
    api.useSyncGroupCwdContext.mockReturnValue({
      cwd: "D:/other",
      sourceTerminalId: "terminal-source",
    });
    api.getWorktreeSnapshot.mockResolvedValue({
      ...snapshot([entry("D:/other", { branch: "other" })]),
      repositoryPath: "D:/other",
    });
    view.rerender(<WorktreeView instanceId="worktree-pane" paneId="pane" syncGroup="ws" />);
    await screen.findByText("other");
    await act(async () => old.resolve(snapshot()));
    expect(screen.queryByText("feature")).not.toBeInTheDocument();
  });

  it("검사 실패는 정리 가능 상태로 취급하지 않고 원인을 노출한다", async () => {
    api.inspectWorktree.mockRejectedValue(new Error("권한 없음"));
    renderView();
    await screen.findByText("feature");
    await waitFor(() => expect(screen.getAllByText(/검사 실패/)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^정리 후보 \d+/ }));
    expect(screen.queryByText("feature")).not.toBeInTheDocument();
  });

  it("검사한 파일은 기존 파일 뷰어에서 내용을 열 수 있다", async () => {
    api.inspectWorktree.mockResolvedValue(
      inspection(clean, {
        files: [{ kind: "untracked", path: "notes.txt" }],
        untrackedFiles: 1,
        blockers: ["untracked_files"],
        canRemove: false,
      }),
    );
    renderView();
    await openDetails();
    const file = await screen.findByRole("button", { name: "미추적 · notes.txt" });
    fireEvent.click(file);
    expect(useFileViewerStore.getState()).toMatchObject({
      open: true,
      path: "D:/repo-clean/notes.txt",
    });
  });

  it("워크트리 수가 많아도 Git 검사는 최대 3개씩 실행한다", async () => {
    const waiting = deferred<WorktreeInspection>();
    api.getWorktreeSnapshot.mockResolvedValue(
      snapshot(
        Array.from({ length: 5 }, (_, i) => entry(`D:/tree-${i}`, { branch: `branch-${i}` })),
      ),
    );
    api.inspectWorktree.mockReturnValue(waiting.promise);
    const view = renderView();
    await screen.findByText("branch-4");
    expect(api.inspectWorktree).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => waiting.resolve(inspection(clean)));
    expect(api.inspectWorktree).toHaveBeenCalledTimes(3);
  });

  it("제거 시점의 백엔드 거부는 표시하고 이전 검사로 다시 제거하지 않는다", async () => {
    api.removeWorktree.mockRejectedValue(new Error("사용 중인 터미널 발견"));
    renderView();
    await openDetails();
    const remove = await screen.findByRole("button", { name: "워크트리 제거" });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "제거 확인" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("사용 중인 터미널 발견");
    expect(screen.queryByRole("button", { name: "제거 확인" })).not.toBeInTheDocument();
  });

  it("WSL CWD의 발신 터미널을 전달하고 후속 검사·제거는 서버가 확정한 배포판 경로를 쓴다", async () => {
    const resolved = "//wsl.localhost/Debian/home/main";
    const linked = entry("//wsl.localhost/Debian/home/feature");
    api.useSyncGroupCwdContext.mockReturnValue({
      cwd: "/home/main",
      sourceTerminalId: "terminal-debian",
    });
    api.getWorktreeSnapshot.mockResolvedValue({
      workingDir: resolved,
      repositoryPath: resolved,
      commonDir: `${resolved}/.git`,
      worktrees: [linked],
    });
    api.inspectWorktree.mockResolvedValue(inspection(linked));
    renderView();
    await openDetails();
    expect(api.getWorktreeSnapshot).toHaveBeenCalledWith("/home/main", "terminal-debian");
    expect(api.inspectWorktree).toHaveBeenCalledWith(resolved, linked.path);
    fireEvent.click(await screen.findByRole("button", { name: "워크트리 제거" }));
    fireEvent.click(screen.getByRole("button", { name: "제거 확인" }));
    await waitFor(() =>
      expect(api.removeWorktree).toHaveBeenCalledWith(resolved, linked.path, linked.head),
    );
  });

  it("CWD 문자열이 같아도 발신 터미널이 바뀌면 이전 저장소와 제거 확인을 무효화한다", async () => {
    const view = renderView();
    await openDetails();
    fireEvent.click(await screen.findByRole("button", { name: "워크트리 제거" }));
    const next = deferred<WorktreeSnapshot>();
    api.getWorktreeSnapshot.mockReturnValue(next.promise);
    api.useSyncGroupCwdContext.mockReturnValue({
      cwd: "D:/repo",
      sourceTerminalId: "another-terminal",
    });
    view.rerender(<WorktreeView instanceId="worktree-pane" paneId="pane" syncGroup="ws" />);
    expect(screen.queryByRole("button", { name: "제거 확인" })).not.toBeInTheDocument();
    expect(api.getWorktreeSnapshot).toHaveBeenLastCalledWith("D:/repo", "another-terminal");
    await act(async () => next.resolve(snapshot([])));
  });
});
