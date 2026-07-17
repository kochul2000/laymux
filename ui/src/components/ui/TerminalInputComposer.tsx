import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import type { InputMode } from "@/lib/terminal-input-composer-state";

export interface TerminalInputComposerLabels {
  editor: string;
  placeholder: string;
  send: string;
}

export interface TerminalInputComposerProps {
  mode: InputMode;
  text: string;
  labels: TerminalInputComposerLabels;
  inFlight?: boolean;
  disabled?: boolean;
  commitDisabled?: boolean;
  autoFocus?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onTextChange: (text: string) => void;
  onSend: () => void;
  className?: string;
  testId?: string;
}

function joinClassNames(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Bottom editor surface for the detached "Composer" input mode. The mode toggle
 * itself lives in the pane control bar (see PaneControlBar), so this component
 * only renders when Composer is active and collapses to an inert, zero-footprint
 * host in Direct mode — the terminal keeps all of its vertical space.
 */
export function TerminalInputComposer({
  mode,
  text,
  labels,
  inFlight = false,
  disabled = false,
  commitDisabled = false,
  autoFocus = false,
  textareaRef,
  onTextChange,
  onSend,
  className,
  testId,
}: TerminalInputComposerProps) {
  const compositionActiveRef = useRef(false);
  const actionDisabled = disabled || commitDisabled || inFlight;
  const childTestId = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);

  useEffect(() => {
    if (mode !== "composer") compositionActiveRef.current = false;
  }, [mode]);

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (
      compositionActiveRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }

    // Plain Enter is the Send gesture. While an action is already in flight,
    // consume repeats without turning them into accidental draft newlines.
    event.preventDefault();
    if (!actionDisabled) onSend();
  };

  // Direct mode keeps the testid/data-mode in the DOM (state probes, tests) but
  // paints nothing.
  if (mode !== "composer") {
    return <div data-testid={testId} data-mode={mode} hidden />;
  }

  return (
    <div
      data-testid={testId}
      data-mode={mode}
      aria-busy={inFlight}
      aria-disabled={disabled || undefined}
      className={joinClassNames(
        "terminal-input-composer flex min-w-0 flex-col gap-2 border-t p-2",
        className,
      )}
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
      }}
    >
      <textarea
        ref={textareaRef}
        data-testid={childTestId("textarea")}
        aria-label={labels.editor}
        value={text}
        placeholder={labels.placeholder}
        disabled={disabled}
        autoFocus={autoFocus && !disabled}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="terminal-input-composer-editor min-h-16 w-full min-w-0 resize-y rounded border px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-base)",
          color: "var(--text-primary)",
        }}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        onCompositionStart={() => {
          compositionActiveRef.current = true;
        }}
        onCompositionEnd={() => {
          compositionActiveRef.current = false;
        }}
        onBlur={() => {
          compositionActiveRef.current = false;
        }}
        onKeyDown={handleEditorKeyDown}
      />

      <div className="terminal-input-composer-actions flex min-w-0 justify-end gap-2">
        <button
          type="button"
          data-testid={childTestId("send")}
          disabled={actionDisabled}
          className="hover-bg-accent rounded border px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            borderColor: "var(--accent)",
            background: "var(--accent-20)",
            color: "var(--accent)",
          }}
          onClick={onSend}
        >
          {labels.send}
        </button>
      </div>
    </div>
  );
}
