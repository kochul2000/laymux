import { useState, useRef, useCallback, useEffect } from "react";

export function useHoverTimer(hoverIdleSeconds: number, active = true) {
  const [hoverState, setHoverState] = useState<{ active: boolean; hoveredId: string | null }>(
    () => ({
      active,
      hoveredId: null,
    }),
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A retained workspace/dock remains mounted while inactive. Reset its
  // ephemeral pointer ownership during render so a later activation cannot
  // briefly paint stale hover UI before an effect gets a chance to run.
  if (hoverState.active !== active) {
    setHoverState({ active, hoveredId: null });
  }
  const hoveredId = hoverState.active === active ? hoverState.hoveredId : null;

  const activate = useCallback(
    (id: string) => {
      if (!active) return;
      setHoverState({ active, hoveredId: id });
      if (timerRef.current) clearTimeout(timerRef.current);
      if (hoverIdleSeconds > 0) {
        timerRef.current = setTimeout(
          () =>
            setHoverState((current) =>
              current.active === active ? { ...current, hoveredId: null } : current,
            ),
          hoverIdleSeconds * 1000,
        );
      }
    },
    [active, hoverIdleSeconds],
  );

  const clear = useCallback(() => {
    setHoverState((current) =>
      current.hoveredId === null ? current : { ...current, hoveredId: null },
    );
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (active || !timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [active]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { hoveredId, activate, clear };
}
