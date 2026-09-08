import { WarningIcon } from "@/components/ui/icons";

interface TerminalOutputStoppedBarProps {
  terminalId: string;
  reason: string;
  title: string;
  description: string;
  restartLabel: string;
  onRestart?: () => void;
}

/** Persistent, actionable notice for a terminal output fail-stop. */
export function TerminalOutputStoppedBar({
  terminalId,
  reason,
  title,
  description,
  restartLabel,
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
      </div>
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          className="shrink-0 rounded border px-3 py-1.5 font-medium"
          style={{
            color: "var(--bg-base)",
            background: "var(--yellow)",
            borderColor: "var(--yellow)",
          }}
        >
          {restartLabel}
        </button>
      )}
    </div>
  );
}
