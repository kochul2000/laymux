import { useEffect, useState } from "react";
import { reclaimRemoteControl } from "@/lib/tauri-api";
import { publishRemoteControlStatus, useRemoteControlStatus } from "@/lib/remote-control-status";
import { useTranslation } from "react-i18next";

export function RemoteControlOverlay() {
  const { t } = useTranslation("common");
  const status = useRemoteControlStatus();
  const [reclaiming, setReclaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!status?.active) return;

    const blockKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-remote-control-reclaim]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", blockKeyboard, true);
    window.addEventListener("keyup", blockKeyboard, true);
    window.addEventListener("keypress", blockKeyboard, true);
    return () => {
      window.removeEventListener("keydown", blockKeyboard, true);
      window.removeEventListener("keyup", blockKeyboard, true);
      window.removeEventListener("keypress", blockKeyboard, true);
    };
  }, [status?.active]);

  if (!status?.active) return null;

  const handleReclaim = async () => {
    setReclaiming(true);
    setError(null);
    try {
      publishRemoteControlStatus(await reclaimRemoteControl());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReclaiming(false);
    }
  };

  const controller =
    status.clientName || status.remoteAddr || t("remoteControl.fallbackController");

  return (
    <div
      className="remote-control-overlay"
      data-testid="remote-control-overlay"
      onPointerDownCapture={(event) => event.stopPropagation()}
      onPointerMoveCapture={(event) => event.stopPropagation()}
      onWheelCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="remote-control-panel" role="dialog" aria-modal="true">
        <div className="remote-control-title">{t("remoteControl.title")}</div>
        <div className="remote-control-body">{t("remoteControl.body", { controller })}</div>
        <button
          type="button"
          className="remote-control-reclaim-button"
          data-remote-control-reclaim
          onClick={handleReclaim}
          disabled={reclaiming}
        >
          {reclaiming ? t("remoteControl.reclaiming") : t("remoteControl.reclaim")}
        </button>
        {error && <div className="remote-control-error">{error}</div>}
      </div>
    </div>
  );
}
