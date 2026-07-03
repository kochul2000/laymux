import { useEffect, useRef } from "react";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

export function useAutoRemoteAccessPrompt(enabled = true) {
  const threshold = useSettingsStore((state) => state.remote.autoMobileModeMinWidth);
  const localMobileModeActive = useLocalMobileModeStore((state) => state.active);
  const promptedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      promptedRef.current = false;
      return;
    }

    const check = () => {
      const width = window.innerWidth;
      if (!Number.isFinite(threshold) || threshold <= 0) {
        promptedRef.current = false;
        return;
      }
      if (width > threshold) {
        promptedRef.current = false;
        return;
      }
      if (promptedRef.current || localMobileModeActive) return;

      useUiStore.getState().openRemoteAccessModal();
      promptedRef.current = true;
    };

    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [enabled, localMobileModeActive, threshold]);
}
