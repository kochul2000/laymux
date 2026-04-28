import { useState, useEffect, type RefObject } from "react";

/**
 * ResizeObserver-backed element size hook.
 *
 * Reports rounded integer pixel dimensions and coalesces multiple resize
 * notifications inside a single animation frame. Identical sizes never trigger
 * a state update so subscribers can rely on `Object.is` equality. This keeps
 * downstream effects from churning during rapid layout shifts (window resize,
 * pane drag, alt-screen redraws) which would otherwise amplify any rendering
 * pressure on the WebView2 GPU process.
 */
export function useContainerSize(containerRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let frame: number | null = null;
    let pending: { w: number; h: number } | null = null;

    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      pending = { w: Math.round(width), h: Math.round(height) };

      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (pending === null) return;
        const next = pending;
        pending = null;
        setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
      });
    });
    ro.observe(el);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [containerRef]);

  return size;
}
