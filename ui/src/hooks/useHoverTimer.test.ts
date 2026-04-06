import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useHoverTimer } from "./useHoverTimer";

describe("useHoverTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initially has null hoveredId", () => {
    const { result } = renderHook(() => useHoverTimer(5));
    expect(result.current.hoveredId).toBeNull();
  });

  it("sets hoveredId on activate", () => {
    const { result } = renderHook(() => useHoverTimer(5));
    act(() => result.current.activate("pane-1"));
    expect(result.current.hoveredId).toBe("pane-1");
  });

  it("clears hoveredId after idle timeout", () => {
    const { result } = renderHook(() => useHoverTimer(3));
    act(() => result.current.activate("pane-1"));
    expect(result.current.hoveredId).toBe("pane-1");

    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.hoveredId).toBeNull();
  });

  it("resets timer on repeated activate", () => {
    const { result } = renderHook(() => useHoverTimer(3));
    act(() => result.current.activate("pane-1"));

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.hoveredId).toBe("pane-1");

    act(() => result.current.activate("pane-1"));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.hoveredId).toBe("pane-1");

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.hoveredId).toBeNull();
  });

  it("clears immediately on clear()", () => {
    const { result } = renderHook(() => useHoverTimer(5));
    act(() => result.current.activate("pane-1"));
    act(() => result.current.clear());
    expect(result.current.hoveredId).toBeNull();
  });

  it("does not auto-clear when hoverIdleSeconds is 0", () => {
    const { result } = renderHook(() => useHoverTimer(0));
    act(() => result.current.activate("pane-1"));
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current.hoveredId).toBe("pane-1");
  });

  it("cleans up timer on unmount", () => {
    const { result, unmount } = renderHook(() => useHoverTimer(3));
    act(() => result.current.activate("pane-1"));
    unmount();
    // Should not throw
    act(() => vi.advanceTimersByTime(5000));
  });
});
