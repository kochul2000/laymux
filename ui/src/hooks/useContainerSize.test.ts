import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useContainerSize } from "./useContainerSize";

describe("useContainerSize", () => {
  let mockObserve: ReturnType<typeof vi.fn>;
  let mockDisconnect: ReturnType<typeof vi.fn>;
  let observerCallback: ResizeObserverCallback;
  let OriginalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    mockObserve = vi.fn();
    mockDisconnect = vi.fn();
    OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        observerCallback = cb;
      }
      observe = mockObserve;
      unobserve = vi.fn();
      disconnect = mockDisconnect;
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  it("returns initial size {w:0, h:0}", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));
    expect(result.current).toEqual({ w: 0, h: 0 });
  });

  it("observes the element from the ref", () => {
    const el = document.createElement("div");
    const ref = { current: el };
    renderHook(() => useContainerSize(ref));
    expect(mockObserve).toHaveBeenCalledWith(el);
  });

  it("updates size when ResizeObserver fires", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    act(() => {
      observerCallback(
        [{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(result.current).toEqual({ w: 800, h: 600 });
  });

  it("disconnects on unmount", () => {
    const ref = { current: document.createElement("div") };
    const { unmount } = renderHook(() => useContainerSize(ref));
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("does not observe if ref.current is null", () => {
    const ref = { current: null };
    renderHook(() => useContainerSize(ref));
    expect(mockObserve).not.toHaveBeenCalled();
  });
});
