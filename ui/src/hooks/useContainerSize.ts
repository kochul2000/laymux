import { useState, useEffect, type RefObject } from "react";

export function useContainerSize(containerRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      // Round to integer pixels and skip same-value updates so consumers
      // (PaneControlBar etc.) do not re-render on sub-pixel DPR jitter,
      // hover bars, or scrollbar layout shimmies. Without this guard a
      // single ControlBar mounting cascades into a fit/atlas-rebuild storm
      // that races with TUI exit bursts.
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  return size;
}
