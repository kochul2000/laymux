import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/tauri-api", () => ({
  getListeningPorts: vi.fn().mockResolvedValue([
    { port: 3000, pid: 12345, process_name: "node" },
    { port: 8080, pid: 6789, process_name: null },
  ]),
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleIdeMessage: vi.fn().mockResolvedValue({}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onIdeNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
}));

import { usePortDetection } from "./usePortDetection";
import { getListeningPorts } from "@/lib/tauri-api";

describe("usePortDetection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fetches ports on mount", async () => {
    const { result } = renderHook(() => usePortDetection(5000));

    // Wait for the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(getListeningPorts).toHaveBeenCalled();
    expect(result.current).toHaveLength(2);
    expect(result.current[0].port).toBe(3000);
  });

  it("polls at specified interval", async () => {
    renderHook(() => usePortDetection(5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(getListeningPorts).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getListeningPorts).toHaveBeenCalledTimes(2);
  });

  it("cleans up interval on unmount", async () => {
    const { unmount } = renderHook(() => usePortDetection(5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    // Should only have been called once (initial fetch), not after unmount
    expect(getListeningPorts).toHaveBeenCalledTimes(1);
  });
});
