import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "@/components/ui/icons";

import {
  getAppUpdateStatus,
  installAppUpdate,
  onAppUpdateStatusChanged,
  type AppUpdateStatus,
} from "@/lib/tauri-api";

function progressPercent(status: AppUpdateStatus): number | null {
  if (!status.totalBytes || status.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100));
}

export function UpdateButton() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void getAppUpdateStatus()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => {});
    void onAppUpdateStatusChanged((snapshot) => {
      if (!cancelled) setStatus(snapshot);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const busy = status?.operation !== "idle";
  const percent = status ? progressPercent(status) : null;
  const error = requestError ?? status?.lastError ?? null;
  const title = useMemo(() => {
    if (!status?.availableVersion) return "";
    if (status.operation === "checking") return "Checking update availability";
    if (status.operation === "installing") return "Installing update; Laymux will restart";
    if (status.operation === "downloading") {
      return percent === null ? "Downloading update" : `Downloading update (${percent}%)`;
    }
    if (error) return `Update ${status.availableVersion} — ${error}`;
    // Name the channel on beta: the same button offers a test build there, and
    // the version string alone does not say which series it came from.
    const channelNote = status.channel === "beta" ? " (beta channel)" : "";
    return `Update ${status.availableVersion}${channelNote} available — click to install and restart`;
  }, [error, percent, status]);

  const handleInstall = useCallback(() => {
    if (!status?.availableVersion || status.operation !== "idle") return;
    // Consent is given here, so the channel has to be visible here — not only in
    // the tooltip that led to the click (ADR-0190).
    const channelNote = status.channel === "beta" ? " from the beta channel" : "";
    if (!window.confirm(`Install Laymux ${status.availableVersion}${channelNote} and restart now?`))
      return;
    setRequestError(null);
    void installAppUpdate()
      .then(setStatus)
      .catch((reason: unknown) => {
        setRequestError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [status]);

  if (!status?.enabled || !status.availableVersion) return null;

  return (
    <button
      data-testid="app-update-btn"
      data-operation={status.operation}
      onClick={handleInstall}
      disabled={busy}
      className="flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 border-0 bg-transparent px-1 text-[10px]"
      style={{
        color: error ? "var(--claude)" : busy ? "var(--accent)" : "var(--yellow)",
        opacity: busy ? 0.85 : 1,
      }}
      title={title}
      aria-label={title}
    >
      <DownloadIcon />
      {busy && <span>{status.operation === "installing" ? "…" : (percent ?? "…")}</span>}
    </button>
  );
}
