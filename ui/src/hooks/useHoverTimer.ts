import { useState, useRef, useCallback, useEffect } from "react";

export function useHoverTimer(hoverIdleSeconds: number) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activate = useCallback(
    (id: string) => {
      setHoveredId(id);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (hoverIdleSeconds > 0) {
        timerRef.current = setTimeout(() => setHoveredId(null), hoverIdleSeconds * 1000);
      }
    },
    [hoverIdleSeconds],
  );

  const clear = useCallback(() => {
    setHoveredId(null);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { hoveredId, activate, clear };
}
