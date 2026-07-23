import { useEffect, useRef } from "react";
import { getRemoteSessionActive, onRemoteSessionChanged } from "@/lib/tauri-api";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Heuristic for "the current OS remote-desktop session is driven by a phone".
 *
 * RDP exposes no device-type flag, so we infer it from the session's display
 * geometry. `window.screen` mirrors the negotiated RDP desktop size, which for
 * a phone client is the phone's own screen: portrait *and* narrow on its short
 * edge. A desktop-to-desktop session is landscape and/or large, so it is
 * excluded — the two conditions together also reject a portrait-rotated monitor
 * (portrait but wide short edge) and a small landscape display (narrow but not
 * portrait). Falls back to `window.innerWidth/innerHeight` where `window.screen`
 * is unavailable. Returns false when the threshold is disabled (<= 0) or
 * non-finite, matching the "auto mobile mode off" setting.
 */
export function isPhoneLikeRemoteScreen(threshold: number): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  const width = window.screen?.width ?? window.innerWidth;
  const height = window.screen?.height ?? window.innerHeight;
  const portrait = height > width;
  const shortEdge = Math.min(width, height);
  return portrait && shortEdge <= threshold;
}

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
  // over a remote session *from a phone-sized client*, independent of the laymux
  // window's own width. Covers the intended scenario — reaching an already-
  // running laymux window via Windows Remote Desktop from a phone — while a
  // desktop-to-desktop RDP session must NOT pop the panel. The initial state is
  // pulled once; live connect events arrive via the backend event. Backend is
  // Windows-only (elsewhere the query resolves `false` and the event never
  // fires).
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const open = () => {
      // Local mobile mode already gives the phone a tailored UI — don't stack
      // the modal on top of it.
      if (useLocalMobileModeStore.getState().active) return;
      // Only a phone-shaped remote screen should auto-open the panel; a desktop
      // RDP session stays untouched. Read the threshold fresh so live setting
      // edits apply without re-registering the OS listener.
      const currentThreshold = useSettingsStore.getState().remote.autoMobileModeMinWidth;
      if (!isPhoneLikeRemoteScreen(currentThreshold)) return;
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
