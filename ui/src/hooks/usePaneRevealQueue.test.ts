import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePaneRevealQueue, type PaneRevealQueueOptions } from "./usePaneRevealQueue";

// Use vitest's own faked requestAnimationFrame/cancelAnimationFrame (consistent
// pair) and spy on rAF to assert the synchronous fast-paths schedule no frame.
let rafSpy: ReturnType<typeof vi.spyOn>;

const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

function frame() {
  // One animation frame on the fake clock (vitest fakes rAF as ~16ms).
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

describe("usePaneRevealQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rafSpy = vi.spyOn(window, "requestAnimationFrame");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const opts = (over: Partial<PaneRevealQueueOptions> = {}): PaneRevealQueueOptions => ({
    active: true,
    focusedPaneId: null,
    ...over,
  });

  it("reveals all panes synchronously at or below initialBatch (no rAF)", () => {
    const { result } = renderHook(() => usePaneRevealQueue(ids(4), opts()));
    expect(sorted(result.current)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("reveals the initial batch (focused first) synchronously, then one per frame", () => {
    const { result } = renderHook(() => usePaneRevealQueue(ids(8), opts({ focusedPaneId: "p7" })));
    // Initial batch = 4, focused hoisted to front.
    expect(sorted(result.current)).toEqual(["p0", "p1", "p2", "p7"]);

    frame();
    expect(result.current.size).toBe(5);
    frame();
    frame();
    frame();
    expect(sorted(result.current)).toEqual(ids(8).sort());
  });

  it("never leaves the focused pane as a placeholder", () => {
    const { result } = renderHook(() => usePaneRevealQueue(ids(8), opts({ focusedPaneId: "p6" })));
    expect(result.current.has("p6")).toBe(true);
  });

  it("reveals a newly-focused pane immediately", () => {
    const { result, rerender } = renderHook(
      ({ focused }) => usePaneRevealQueue(ids(8), opts({ focusedPaneId: focused })),
      { initialProps: { focused: null as string | null } },
    );
    expect(result.current.has("p6")).toBe(false);
    act(() => rerender({ focused: "p6" }));
    expect(result.current.has("p6")).toBe(true);
  });

  it("pauses while inactive and resumes when active again", () => {
    const { result, rerender } = renderHook(
      ({ active }) => usePaneRevealQueue(ids(8), opts({ active })),
      { initialProps: { active: false } },
    );
    const initial = result.current.size;
    frame();
    frame();
    expect(result.current.size).toBe(initial); // paused, no growth

    act(() => rerender({ active: true }));
    frame();
    frame();
    frame();
    frame();
    expect(sorted(result.current)).toEqual(ids(8).sort());
  });

  it("keeps revealed panes across a reorder with the same id set (swap)", () => {
    const list = ids(8);
    const { result, rerender } = renderHook(({ panes }) => usePaneRevealQueue(panes, opts()), {
      initialProps: { panes: list },
    });
    // Drain fully.
    for (let i = 0; i < 6; i++) frame();
    expect(sorted(result.current)).toEqual(list.slice().sort());

    // Swap two ids (same set, reordered) → nothing should un-reveal.
    const swapped = [...list];
    [swapped[0], swapped[7]] = [swapped[7], swapped[0]];
    act(() => rerender({ panes: swapped }));
    expect(sorted(result.current)).toEqual(list.slice().sort());
  });

  it("prunes removed panes from the revealed set", () => {
    const { result, rerender } = renderHook(({ panes }) => usePaneRevealQueue(panes, opts()), {
      initialProps: { panes: ids(8) },
    });
    for (let i = 0; i < 6; i++) frame();
    expect(result.current.has("p7")).toBe(true);

    act(() => rerender({ panes: ids(6) })); // p6, p7 removed
    expect(result.current.has("p6")).toBe(false);
    expect(result.current.has("p7")).toBe(false);
  });

  it("reveals everything synchronously under prefers-reduced-motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true, media: "", addEventListener: vi.fn() }),
    );
    const { result } = renderHook(() => usePaneRevealQueue(ids(10), opts()));
    expect(sorted(result.current)).toEqual(ids(10).sort());
    expect(rafSpy).not.toHaveBeenCalled();
  });
});
