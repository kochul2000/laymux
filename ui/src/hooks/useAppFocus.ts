import { useEffect } from "react";
import { useUiStore } from "@/stores/ui-store";

/**
 * Listens for window focus/blur events and updates `isAppFocused` in the UI store.
 * When the app loses focus (e.g. Alt+Tab), pane focus indicators can be dimmed.
 */
export function useAppFocus() {
  const setAppFocused = useUiStore((s) => s.setAppFocused);

  useEffect(() => {
    const onFocus = () => setAppFocused(true);
    const onBlur = () => setAppFocused(false);

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [setAppFocused]);
}
