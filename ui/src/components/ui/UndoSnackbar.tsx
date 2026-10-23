import { useEffect, useState } from "react";
import { ToastCountdown, type ToastCountdownProps } from "./ToastCountdown";

interface UndoSnackbarProps {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  durationMs?: number | null;
  countdown?: ToastCountdownProps;
}

/** Transient, keyboard-accessible feedback for a single reversible UI action. */
export function UndoSnackbar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 5000,
  countdown,
}: UndoSnackbarProps) {
  const [openedAt] = useState(() => Date.now());
  const progress =
    countdown ?? (durationMs === null ? null : { durationMs, expiresAt: openedAt + durationMs });
  useEffect(() => {
    if (durationMs === null) return;
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDismiss]);

  return (
    <div role="status" aria-live="polite" className="undo-snackbar">
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <span aria-hidden="true" className="undo-snackbar-separator">
        ·
      </span>
      <button
        type="button"
        data-testid="undo-snackbar-action"
        className="undo-snackbar-action hover-bg-strong"
        onClick={onAction}
      >
        {actionLabel}
      </button>
      {progress && progress.durationMs > 0 && (
        <ToastCountdown key={`${progress.expiresAt}:${progress.durationMs}`} {...progress} />
      )}
    </div>
  );
}
