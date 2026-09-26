import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LifecycleProgress } from "@/components/ui/LifecycleProgress";
import { lifecycleCopy, type ExitProgress } from "@/lib/lifecycle-progress";
import {
  checkAppUpdate,
  getAppUpdateStatus,
  installAppUpdate,
  onAppUpdateStatusChanged,
} from "@/lib/tauri-api";
import { useLifecycleStore, keepWaitingForClose } from "@/stores/lifecycle-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

/** Mounted above Settings: closing the dialog never discards a settings draft. */
export function LifecycleModal() {
  const state = useLifecycleStore();
  const { i18n } = useTranslation();
  const ko = i18n.language.startsWith("ko");
  const copy = lifecycleCopy[ko ? "ko" : "en"];
  const cleanupSetting = useSettingsStore((s) => s.exit.interruptTerminals);
  const dialog = useRef<HTMLDialogElement>(null);
  const [requesting, setRequesting] = useState(false);
  const status = state.status;
  const close = state.kind === "close";
  const operation = status?.operation ?? "idle";
  const busy = close || ["downloading", "preparing", "installing"].includes(operation);
  const locked = close || operation === "preparing" || operation === "installing";
  const cleanup = close
    ? state.cleanup
    : (status?.exitSettings?.interruptTerminals ?? cleanupSetting);
  const progress: ExitProgress =
    state.progress && (close || state.preview)
      ? state.progress
      : operation === "downloading"
        ? {
            stage: "downloading",
            completed: status?.downloadedBytes ?? 0,
            total: status?.totalBytes ?? null,
          }
        : operation === "installing"
          ? { stage: "installing", completed: 0, total: null }
          : (status?.preparation ?? { stage: "checkpoint", completed: 0, total: null });
  const dismiss = () => {
    if (state.preview) {
      useLifecycleStore.setState({
        open: false,
        preview: false,
        kind: "update",
        progress: null,
        status: null,
        error: null,
      });
      void getAppUpdateStatus()
        .then((snapshot) => useLifecycleStore.getState().receiveStatus(snapshot))
        .catch(() => {});
    } else if (!locked) useLifecycleStore.setState({ open: false, preview: false, progress: null });
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Subscribe before reading; a late initial snapshot must not overwrite an event.
    let receivedEvent = false;
    const initialStatus = useLifecycleStore.getState().status;
    void onAppUpdateStatusChanged((snapshot) => {
      if (disposed) return;
      receivedEvent = true;
      useLifecycleStore.getState().receiveStatus(snapshot);
    })
      .then(async (stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        const snapshot = await getAppUpdateStatus();
        if (!disposed && !receivedEvent && useLifecycleStore.getState().status === initialStatus)
          useLifecycleStore.getState().receiveStatus(snapshot);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (state.open && element && !element.open) element.showModal();
    else if (!state.open && element?.open) element.close();
  }, [state.open]);

  const run = async (install: boolean) => {
    if (state.preview || requesting) return;
    setRequesting(true);
    const requestStatus = useLifecycleStore.getState().status;
    useLifecycleStore.setState({ error: null });
    try {
      const snapshot = await (install ? installAppUpdate() : checkAppUpdate());
      if (useLifecycleStore.getState().status === requestStatus)
        useLifecycleStore.getState().receiveStatus(snapshot);
      if (snapshot.lastError) useLifecycleStore.setState({ error: snapshot.lastError });
    } catch (cause) {
      useLifecycleStore.setState({ error: String(cause) });
    } finally {
      setRequesting(false);
    }
  };
  const openSettings = () => {
    dismiss();
    useUiStore.getState().setSettingsNavTarget("terminal");
    useUiStore.getState().openSettingsModal();
  };

  return (
    <>
      {state.open && <div className="lifecycle-backdrop" aria-hidden="true" />}
      <dialog
        ref={dialog}
        className="lifecycle-dialog"
        data-testid="lifecycle-modal"
        aria-labelledby="lifecycle-title"
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => event.stopPropagation()}
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
      >
        <div className="lifecycle-content">
          <h2 id="lifecycle-title" className="lifecycle-title">
            {close ? copy.closeTitle : busy ? copy.updateBusy : copy.updateTitle}
          </h2>
          {!close && (
            <div className="lifecycle-version">
              <span>{status?.currentVersion ?? "—"}</span>
              <ArrowRight size={16} />
              <strong>{status?.availableVersion ?? status?.currentVersion ?? "—"}</strong>
              <span className="lifecycle-channel">
                {status?.channel === "beta" ? copy.beta : copy.stable}
              </span>
            </div>
          )}
          {busy || (status?.preparation && state.error) ? (
            <LifecycleProgress
              kind={state.kind}
              cleanup={cleanup}
              progress={progress}
              ko={ko}
              failed={Boolean(state.error)}
            />
          ) : (
            <>
              {status?.notes && (
                <details className="lifecycle-notes" open>
                  <summary>{copy.details}</summary>
                  <pre>{status.notes}</pre>
                </details>
              )}
              <p className="lifecycle-subtitle">
                {operation === "checking"
                  ? copy.checking
                  : status?.enabled === false
                    ? copy.dev
                    : !status?.availableVersion
                      ? copy.latest
                      : ""}
              </p>
              <div className="lifecycle-info">
                {cleanup ? copy.cleanupOn : copy.cleanupOff}
                <br />
                <Button variant="secondary" onClick={openSettings}>
                  {copy.settings}
                </Button>
              </div>
            </>
          )}
          {progress.warning && busy && (
            <div className="lifecycle-error" role="status">
              {progress.warning}
            </div>
          )}
          {state.error && (
            <div className="lifecycle-error" role="alert">
              <strong>{state.error === "timeout" ? copy.waiting : copy.failure}</strong>
              <br />
              {state.error !== "timeout" && state.error}
              {close && <p>{copy.shutdownWarning}</p>}
            </div>
          )}
          {state.preview && <div className="lifecycle-preview">{copy.preview}</div>}
        </div>
        {(!locked || state.error || state.preview) && (
          <div className="lifecycle-actions">
            {close && state.forceClose ? (
              <>
                {state.error === "timeout" && (
                  <Button onClick={keepWaitingForClose}>{copy.wait}</Button>
                )}
                <Button variant="primary" onClick={state.forceClose}>
                  {copy.force}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={dismiss}>{busy ? copy.hide : copy.later}</Button>
                {!busy && (
                  <Button
                    disabled={
                      requesting || !status?.enabled || operation !== "idle" || state.preview
                    }
                    title={!status?.enabled ? copy.dev : undefined}
                    onClick={() => void run(false)}
                  >
                    {copy.check}
                  </Button>
                )}
                {!busy && status?.availableVersion && (
                  <Button
                    variant="primary"
                    disabled={
                      requesting || !status.enabled || operation !== "idle" || state.preview
                    }
                    onClick={() => void run(true)}
                  >
                    {copy.install}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </dialog>
    </>
  );
}
