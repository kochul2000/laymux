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

import { useSyncGroupCwd } from "./useSyncGroupCwd";
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

  it("follows a group terminal's CWD change", async () => {
    seedTerminal("t1", "ws-1", "/repo/a");
    const { result } = renderHook(() =>
      useSyncGroupCwd({ syncGroup: "ws-1", instanceId: "view-1" }),
    );

    await emitCwdChanged({ terminalId: "t1", cwd: "/repo/b" });

    expect(result.current).toBe("/repo/b");
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
});
