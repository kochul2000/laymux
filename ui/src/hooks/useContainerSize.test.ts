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

  it("preserves the previous reference on identical integer sizes", () => {
    // ResizeObserver fires on every sub-pixel layout shift. Without a guard,
    // each tick produces a fresh `{w, h}` object that re-renders consumers
    // (e.g. PaneControlBar) and re-runs their measurement loops — which is
    // the burst that compounds with WebGL atlas rebuilds in adjacent panes.
    const ref = { current: document.createElement("div") };
    const { result } = renderHook(() => useContainerSize(ref));

    act(() => {
      observerCallback(
        [{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    const first = result.current;

    // Sub-pixel jitter — same integer size after rounding.
    act(() => {
      observerCallback(
        [{ contentRect: { width: 800.4, height: 599.7 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    // Reference identity preserved → consumers do not re-render.
    expect(result.current).toBe(first);

    // A real integer-level change must still update.
    act(() => {
      observerCallback(
        [{ contentRect: { width: 900, height: 700 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(result.current).toEqual({ w: 900, h: 700 });
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
