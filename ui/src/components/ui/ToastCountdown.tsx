import { useState } from "react";

export interface ToastCountdownProps {
  expiresAt: number;
  durationMs: number;
}

/** Decorative remaining-time cue; the action's owner still controls expiry. */
export function ToastCountdown({ expiresAt, durationMs }: ToastCountdownProps) {
  const [elapsedMs] = useState(() =>
    Math.min(durationMs, Math.max(0, durationMs - (expiresAt - Date.now()))),
  );
  return (
    <div className="toast-countdown" data-testid="toast-countdown" aria-hidden="true">
      <div
        className="toast-countdown-fill"
        style={{ animationDuration: `${durationMs}ms`, animationDelay: `${-elapsedMs}ms` }}
      />
    </div>
  );
}
