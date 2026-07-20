import { useEffect, useRef } from "react";
import { getRemoteSessionActive, onRemoteSessionChanged } from "@/lib/tauri-api";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

export function useAutoRemoteAccessPrompt(enabled = true) {
  const threshold = useSettingsStore((state) => state.remote.autoMobileModeMinWidth);
  const localMobileModeActive = useLocalMobileModeStore((state) => state.active);
  const promptedRef = useRef(false);

  // Narrow-window heuristic: open the panel when the app is rendered into a
  // small viewport (e.g. a browser opened at phone size). Fires on mount and on
  // resize. This does NOT reliably cover a phone RDP session — those connect at
  // full resolution and a non-maximized window never resizes — which the OS
  // remote-session effect below handles.
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

  // OS remote-desktop (RDP) trigger: open the panel when the window is entered
  // over a remote session, independent of window width. Covers the intended
  // scenario — reaching an already-running laymux window via Windows Remote
  // Desktop from a phone. The initial state is pulled once; live connect events
  // arrive via the backend event. Backend is Windows-only (elsewhere the query
  // resolves `false` and the event never fires).
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const open = () => {
      // Local mobile mode already gives the phone a tailored UI — don't stack
      // the modal on top of it.
      if (useLocalMobileModeStore.getState().active) return;
      useUiStore.getState().openRemoteAccessModal();
    };

    getRemoteSessionActive()
      .then((active) => {
        if (!cancelled && active) open();
      })
      .catch(() => {
        /* not in Tauri / not on Windows — ignore */
      });

    onRemoteSessionChanged((active) => {
      if (active) open();
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        /* listener registration unavailable — ignore */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);
}
