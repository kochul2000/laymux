import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRemoteControlStatus: vi.fn(),
  onRemoteControlChanged: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  getRemoteControlStatus: api.getRemoteControlStatus,
  onRemoteControlChanged: api.onRemoteControlChanged,
}));

import {
  __resetRemoteControlStatusForTest,
  useRemoteControlStatus,
  useRemoteControlStatusSnapshot,
} from "./remote-control-status";

const inactiveStatus = {
  active: false,
  leaseId: null,
  remoteAddr: null,
  clientName: null,
  heartbeatTimeoutSeconds: 15,
};

const activeStatus = {
  active: true,
  leaseId: "lease-1",
  remoteAddr: "127.0.0.1:1234",
  clientName: "browser",
  heartbeatTimeoutSeconds: 15,
};

describe("remote control status coordinator", () => {
  beforeEach(() => {
    __resetRemoteControlStatusForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetRemoteControlStatusForTest();
    vi.useRealTimers();
  });

  it("shares one listener and one initial snapshot across every consumer", async () => {
    let resolveListener!: (cleanup: () => void) => void;
    const cleanup = vi.fn();
    api.onRemoteControlChanged.mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );
    api.getRemoteControlStatus.mockResolvedValue(inactiveStatus);

    const first = renderHook(() => useRemoteControlStatus());
    const second = renderHook(() => useRemoteControlStatus());

    expect(api.onRemoteControlChanged).toHaveBeenCalledTimes(1);
    expect(api.getRemoteControlStatus).not.toHaveBeenCalled();

    await act(async () => resolveListener(cleanup));
    await waitFor(() => expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1));
    expect(first.result.current).toEqual(inactiveStatus);
    expect(second.result.current).toEqual(inactiveStatus);

    first.unmount();
    expect(cleanup).not.toHaveBeenCalled();
    second.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("discards a stale snapshot that resolves after an owner event", async () => {
    let eventHandler!: (status: typeof activeStatus) => void;
    let resolveStatus!: (status: typeof inactiveStatus) => void;
    api.onRemoteControlChanged.mockImplementation(async (callback) => {
      eventHandler = callback;
      return vi.fn();
    });
    api.getRemoteControlStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const { result } = renderHook(() => useRemoteControlStatus());
    await waitFor(() => expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1));

    act(() => eventHandler(activeStatus));
    expect(result.current).toEqual(activeStatus);

    await act(async () => resolveStatus(inactiveStatus));
    expect(result.current).toEqual(activeStatus);
  });

  it("reschedules a skipped poll after the pending snapshot finishes", async () => {
    vi.useFakeTimers();
    let eventHandler!: (status: typeof activeStatus) => void;
    let resolveInitialStatus!: (status: typeof inactiveStatus) => void;
    api.onRemoteControlChanged.mockImplementation(async (callback) => {
      eventHandler = callback;
      return vi.fn();
    });
    api.getRemoteControlStatus
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitialStatus = resolve;
        }),
      )
      .mockResolvedValueOnce(inactiveStatus);

    const { result } = renderHook(() => useRemoteControlStatus());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);

    act(() => eventHandler(activeStatus));
    expect(result.current).toEqual(activeStatus);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialStatus(inactiveStatus);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toEqual(activeStatus);

    await act(async () => {
      vi.advanceTimersByTime(2_999);
      await Promise.resolve();
    });
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(inactiveStatus);
  });

  it("records a Remote to Local transition even when React batches both events", async () => {
    let eventHandler!: (status: typeof activeStatus) => void;
    api.onRemoteControlChanged.mockImplementation(async (callback) => {
      eventHandler = callback;
      return vi.fn();
    });
    api.getRemoteControlStatus.mockResolvedValue(inactiveStatus);

    const { result } = renderHook(() => useRemoteControlStatusSnapshot());
    await waitFor(() => expect(result.current.status).toEqual(inactiveStatus));

    act(() => {
      eventHandler(activeStatus);
      eventHandler(inactiveStatus);
    });

    expect(result.current.status).toEqual(inactiveStatus);
    expect(result.current.releaseRevision).toBe(1);
  });

  it("uses one sequential fallback poll while remote control remains active", async () => {
    vi.useFakeTimers();
    api.onRemoteControlChanged.mockResolvedValue(vi.fn());
    api.getRemoteControlStatus
      .mockResolvedValueOnce(activeStatus)
      .mockResolvedValueOnce(inactiveStatus);

    const { result } = renderHook(() => useRemoteControlStatus());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(activeStatus);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(inactiveStatus);
  });
});
