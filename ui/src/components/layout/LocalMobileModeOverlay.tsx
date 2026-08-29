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
  const exit = useLocalMobileModeStore((state) => state.exit);
  const { t } = useTranslation("common");
  // Keyed by the URL they were observed for, so a new entry starts over without
  // an effect resetting state on the way in.
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [timedOutUrl, setTimedOutUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !url) return;
    const origin = frameOrigin(url);

    const handleMessage = (event: MessageEvent) => {
      // The Remote page renders host files inside sandboxed iframes of its own;
      // only the embedded page's own origin gets to drive the desktop around it.
      if (origin !== null && event.origin !== origin) return;
      const type = (event.data as { type?: string } | null)?.type;
      if (type === DESKTOP_MODE_MESSAGE) exit();
      else if (type === READY_MESSAGE) setReadyUrl(url);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [active, url, exit]);

  useEffect(() => {
    if (!active || !url) return;
    const timer = window.setTimeout(() => setTimedOutUrl(url), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [active, url]);

  useEffect(() => {
    if (!active) return;
    // Escape only reaches the host document while the frame does not have
    // focus — which is exactly the stuck case. A live mobile view swallows it.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, exit]);

  if (!active || !url) return null;

  const stuck = readyUrl !== url && timedOutUrl === url;

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
