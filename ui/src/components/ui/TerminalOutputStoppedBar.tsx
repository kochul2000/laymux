import { WarningIcon } from "@/components/ui/icons";

interface TerminalOutputStoppedBarProps {
  terminalId: string;
  reason: string;
  title: string;
  description: string;
  restartLabel: string;
  reconnectLabel: string;
  reconnectingLabel: string;
  restartWarning: string;
  reconnecting: boolean;
  error?: string;
  onReconnect: () => void;
  onRestart?: () => void;
}

/** Persistent, actionable notice for a terminal output fail-stop. */
export function TerminalOutputStoppedBar({
  terminalId,
  reason,
  title,
  description,
  restartLabel,
  reconnectLabel,
  reconnectingLabel,
  restartWarning,
  reconnecting,
  error,
  onReconnect,
  onRestart,
}: TerminalOutputStoppedBarProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid={`terminal-output-stopped-${terminalId}`}
      className="absolute inset-x-0 top-0 z-20 flex min-h-12 items-center gap-3 border-b px-3 py-2 text-xs shadow-lg"
      style={{
        color: "var(--text-primary)",
        background: "var(--bg-surface)",
        borderColor: "var(--yellow)",
      }}
    >
      <WarningIcon size={18} className="shrink-0" style={{ color: "var(--yellow)" }} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
          {description} <span className="font-mono">({reason})</span>
        </div>
        {error && (
          <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            {error}
          </div>
        )}
        {onRestart && (
          <div className="text-[11px]" style={{ color: "var(--red)" }}>
            {restartWarning}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onReconnect}
        disabled={reconnecting}
        className="shrink-0 border px-3 py-1.5 font-medium disabled:opacity-50"
        style={{
          color: "var(--bg-base)",
          background: "var(--yellow)",
          borderColor: "var(--yellow)",
        }}
      >
        {reconnecting ? reconnectingLabel : reconnectLabel}
      </button>
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          disabled={reconnecting}
          title={restartWarning}
          className="shrink-0 border px-3 py-1.5 font-medium disabled:opacity-50"
          style={{
            color: "var(--bg-base)",
            background: "var(--red)",
            borderColor: "var(--red)",
          }}
        >
          {restartLabel}
        </button>
      )}
    </div>
  );
}
