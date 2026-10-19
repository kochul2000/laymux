import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

type CwdChangedPayload = { terminalId: string; cwd: string; cwdSend?: boolean };
type SyncCwdPayload = { terminalId: string; groupId: string; path: string; force?: boolean };

const listeners: {
  cwdChanged: ((data: CwdChangedPayload) => void)[];
  syncCwd: ((data: SyncCwdPayload) => void)[];
} = { cwdChanged: [], syncCwd: [] };

vi.mock("@/lib/tauri-api", () => ({
  onTerminalCwdChanged: vi.fn((cb: (data: CwdChangedPayload) => void) => {
    listeners.cwdChanged.push(cb);
    return Promise.resolve(() => {});
  }),
  onSyncCwd: vi.fn((cb: (data: SyncCwdPayload) => void) => {
    listeners.syncCwd.push(cb);
    return Promise.resolve(() => {});
  }),
}));

import { useSyncGroupCwd, useSyncGroupCwdContext } from "./useSyncGroupCwd";
import { useTerminalStore } from "@/stores/terminal-store";

function seedTerminal(id: string, syncGroup: string, cwd: string) {
  useTerminalStore.setState({
    instances: [{ id, syncGroup, cwd } as never],
  });
}

async function emitCwdChanged(data: CwdChangedPayload) {
  await act(async () => {
    for (const cb of listeners.cwdChanged) cb(data);
  });
}

async function emitSyncCwd(data: SyncCwdPayload) {
  await act(async () => {
    for (const cb of listeners.syncCwd) cb(data);
  });
}

describe("useSyncGroupCwd", () => {
  beforeEach(() => {
    listeners.cwdChanged = [];
    listeners.syncCwd = [];
    useTerminalStore.setState({ instances: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("seeds from the sync group's current CWD at mount", () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );
    expect(result.current).toBe("/repo/a");
  });

  it("명시한 초기 경로는 마운트 씨앗이고 다음 CWD 수신으로 바뀐다", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwdContext({
        syncGroup: "ws-1",
        instanceId: "view-1",
        initialCwd: "D:/initial",
      }),
    );
    expect(result.current).toEqual({ cwd: "D:/initial", sourceTerminalId: undefined });
    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b" });
    expect(result.current).toEqual({ cwd: "/repo/b", sourceTerminalId: "t1" });
  });

  it("명시한 초기 경로도 기존 pane CWD 수신 설정으로 유지하거나 따라간다", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result, rerender } = renderHook(
      ({ receive }) =>
        useSyncGroupCwdContext({
          syncGroup: "ws-1",
          instanceId: "view-1",
          initialCwd: "D:/initial",
          cwdReceive: receive,
        }),
      { initialProps: { receive: false } },
    );
    await emitSyncCwd({ terminalId: "t1", groupId: "ws-1", path: "/repo/forced", force: true });
    expect(result.current.cwd).toBe("D:/initial");
    rerender({ receive: true });
    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b" });
    expect(result.current).toEqual({ cwd: "/repo/b", sourceTerminalId: "t1" });
  });

  it("follows a group terminal's CWD change", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );

    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b" });

    expect(result.current).toBe("/repo/b");
  });

  it("그룹 전환은 수신이 꺼진 대상과 실제 발신 환경을 유지한다", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result, rerender } = renderHook(
      ({ group, receive }) =>
        useSyncGroupCwdContext({ syncGroup: group, instanceId: "dock", cwdReceive: receive }),
      { initialProps: { group: "ws-1", receive: false } },
    );
    act(() => seedTerminal("t2", "ws-2", "/repo/b"));
    rerender({ group: "ws-2", receive: false });
    expect(result.current).toEqual({ cwd: "/repo/a", sourceTerminalId: "t1" });
    rerender({ group: "ws-2", receive: true });
    expect(result.current).toEqual({ cwd: "/repo/b", sourceTerminalId: "t2" });
  });

  it("수신 중 터미널 없는 그룹으로 전환하면 이전 저장소를 현재 대상으로 남기지 않는다", () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result, rerender } = renderHook(
      ({ group }) => useSyncGroupCwdContext({ syncGroup: group, instanceId: "dock" }),
      { initialProps: { group: "ws-1" } },
    );
    rerender({ group: "empty" });
    expect(result.current).toEqual({ cwd: "", sourceTerminalId: undefined });
    rerender({ group: "ws-1" });
    expect(result.current).toEqual({ cwd: "/repo/a", sourceTerminalId: "t1" });
  });

  it("ignores terminals outside its sync group", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    useTerminalStore.setState({
      instances: [
        { id: "t1", syncGroup: "ws-1", cwd: "/repo/a" } as never,
        { id: "t2", syncGroup: "ws-2", cwd: "/other" } as never,
      ],
    });
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );

    await emitCwdChanged({ terminalId: "t2", cwd: "/other/deep" });

    expect(result.current).toBe("/repo/a");
  });

  it("ignores a source that does not propagate its CWD", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );

    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b", cwdSend: false });

    expect(result.current).toBe("/repo/a");
  });

  it("honours this pane's receive gate even for a forced propagation", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1", cwdReceive: false }),
    );

    await emitSyncCwd({ terminalId: "t1", groupId: "ws-1", path: "/repo/forced", force: true });
    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b" });

    expect(result.current).toBe("/repo/a");
  });

  it("applies a forced propagation from another member of the group", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );

    await emitSyncCwd({ terminalId: "view-1", groupId: "ws-1", path: "/self", force: true });
    expect(result.current).toBe("/repo/a");

    await emitSyncCwd({ terminalId: "t1", groupId: "ws-1", path: "/repo/forced", force: true });
    expect(result.current).toBe("/repo/forced");
  });

  it("같은 CWD를 가진 두 WSL 터미널도 마지막 전파 출처를 구분한다", async () => {
    useTerminalStore.setState({
      instances: [
        { id: "debian", syncGroup: "ws-1", cwd: "/home/repo" } as never,
        { id: "ubuntu", syncGroup: "ws-1", cwd: "/home/repo" } as never,
      ],
    });
    const { result } = renderHook(() =>
      useSyncGroupCwdContext({ syncGroup: "ws-1", instanceId: "view-1" }),
    );
    expect(result.current).toEqual({ cwd: "/home/repo", sourceTerminalId: "debian" });
    await emitCwdChanged({ terminalId: "ubuntu", cwd: "/home/repo" });
    expect(result.current).toEqual({ cwd: "/home/repo", sourceTerminalId: "ubuntu" });
    await emitSyncCwd({ terminalId: "debian", groupId: "ws-1", path: "/home/repo", force: true });
    expect(result.current).toEqual({ cwd: "/home/repo", sourceTerminalId: "debian" });
  });

  it("강제 전파가 그룹 전체 store를 갱신해도 실제 발신 터미널을 유지한다", async () => {
    useTerminalStore.setState({
      instances: [
        { id: "ubuntu", syncGroup: "ws-1", cwd: "/home/old" } as never,
        { id: "debian", syncGroup: "ws-1", cwd: "/home/old" } as never,
      ],
    });
    const { result } = renderHook(() =>
      useSyncGroupCwdContext({ syncGroup: "ws-1", instanceId: "view-1" }),
    );
    await act(async () => {
      useTerminalStore.setState({
        instances: [
          { id: "ubuntu", syncGroup: "ws-1", cwd: "/home/new" } as never,
          { id: "debian", syncGroup: "ws-1", cwd: "/home/new" } as never,
        ],
      });
      listeners.syncCwd.forEach((listener) =>
        listener({ terminalId: "debian", groupId: "ws-1", path: "/home/new", force: true }),
      );
    });
    expect(result.current).toEqual({ cwd: "/home/new", sourceTerminalId: "debian" });
  });
});
