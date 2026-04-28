import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useContainerSize } from "./useContainerSize";

describe("useContainerSize", () => {
  let mockObserve: ReturnType<typeof vi.fn>;
  let mockDisconnect: ReturnType<typeof vi.fn>;
  let observerCallback: ResizeObserverCallback;
  let OriginalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  function fire(width: number, height: number) {
    act(() => {
      observerCallback(
        [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
  }

  function flushFrames() {
    act(() => {
      vi.runAllTimers();
    });
  }

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

  it("updates size on the next animation frame", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    fire(800, 600);
    flushFrames();

    expect(result.current).toEqual({ w: 800, h: 600 });
  });

  it("rounds fractional dimensions to integers", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    fire(800.6, 599.4);
    flushFrames();

    expect(result.current).toEqual({ w: 801, h: 599 });
  });

  it("coalesces multiple resizes inside the same frame", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    fire(700, 500);
    fire(720, 520);
    fire(800, 600);
    flushFrames();

    expect(result.current).toEqual({ w: 800, h: 600 });
  });

  it("returns a stable reference when the rounded size is unchanged", () => {
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    fire(800, 600);
    flushFrames();
    const first = result.current;

    fire(800.2, 600.3);
    flushFrames();

    expect(result.current).toBe(first);
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
