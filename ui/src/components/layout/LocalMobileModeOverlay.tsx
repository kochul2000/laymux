import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";

const READY_MESSAGE = "laymux:mobile-mode-ready";
const DESKTOP_MODE_MESSAGE = "laymux:desktop-mode";

/**
 * How long the embedded Remote page has to announce itself before the host
 * draws its own way out. A refused embed still fires the iframe's `load`, so
 * the greeting is the only signal that the page is actually running — and
 * without it the overlay's sole exit lived inside a frame that never came up
 * (#955).
 */
const READY_TIMEOUT_MS = 4000;

function frameOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function LocalMobileModeOverlay() {
  const active = useLocalMobileModeStore((state) => state.active);
  const url = useLocalMobileModeStore((state) => state.url);
  const session = useLocalMobileModeStore((state) => state.session);
  const exit = useLocalMobileModeStore((state) => state.exit);
  const { t } = useTranslation("common");
  // Keyed by the entry they were observed for. This component never unmounts
  // (App renders it unconditionally), so without the key a later entry would
  // inherit the earlier one's verdict.
  const [readySession, setReadySession] = useState(0);
  const [timedOutSession, setTimedOutSession] = useState(0);
  const ready = readySession === session;

  useEffect(() => {
    if (!active || !url) return;
    const origin = frameOrigin(url);

    const handleMessage = (event: MessageEvent) => {
      // Only the embedded page's own origin gets to drive the desktop around
      // it. Fail closed if the URL has no origin to compare against: the host
      // keeps Escape and the timeout card, so refusing costs no way out.
      if (origin === null || event.origin !== origin) return;
      const type = (event.data as { type?: string } | null)?.type;
      if (type === DESKTOP_MODE_MESSAGE) exit();
      else if (type === READY_MESSAGE) setReadySession(session);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [active, url, session, exit]);

  useEffect(() => {
    if (!active || !url) return;
    const timer = window.setTimeout(() => setTimedOutSession(session), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [active, url, session]);

  useEffect(() => {
    if (!active || ready) return;
    // Escape belongs to the host only until the frame says it is running. A
    // live mobile view owns the key for its own drawers and overlays; a frame
    // that never greeted us owns nothing, and this is the way out.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, ready, exit]);

  if (!active || !url) return null;

  const stuck = !ready && timedOutSession === session;

  return (
    <div className="local-mobile-mode-overlay" data-testid="local-mobile-mode-overlay">
      {stuck ? (
        <div
          className="local-mobile-mode-fallback"
          data-testid="local-mobile-mode-fallback"
          role="alert"
        >
          <p className="local-mobile-mode-fallback-title">
            {t("remoteAccess.mobileModeFrameStuckTitle")}
          </p>
          <p className="local-mobile-mode-fallback-body">
            {t("remoteAccess.mobileModeFrameStuckBody")}
          </p>
          <button
            className="local-mobile-mode-fallback-exit"
            data-testid="local-mobile-mode-exit"
            onClick={exit}
            type="button"
          >
            {t("remoteAccess.exitMobileMode")}
          </button>
        </div>
      ) : null}
      <iframe
        allow="clipboard-write"
        className="local-mobile-mode-frame"
        data-testid="local-mobile-mode-frame"
        title="Laymux mobile mode"
        src={url}
      />
    </div>
  );
}
