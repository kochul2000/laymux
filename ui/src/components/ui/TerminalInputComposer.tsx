import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import {
  clampComposerHeight,
  readComposerHeight,
  writeComposerHeight,
  type InputMode,
} from "@/lib/terminal-input-composer-state";

export interface TerminalInputComposerLabels {
  editor: string;
  placeholder: string;
  resize: string;
}

export interface TerminalInputComposerProps {
  mode: InputMode;
  text: string;
  labels: TerminalInputComposerLabels;
  inFlight?: boolean;
  disabled?: boolean;
  commitDisabled?: boolean;
  autoFocus?: boolean;
  /**
   * True at a shell command prompt (OSC 133 input phase). The Composer only owns
   * keys while at the prompt; when a program is running it forwards every key to
   * the PTY so menus / TUIs / their own history behave natively. Defaults to true
   * so an unintegrated shell keeps a usable Composer.
   */
  atShellPrompt?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onTextChange: (text: string) => void;
  onSend: () => void;
  /**
   * Forward a keystroke straight to the terminal (used while a program is
   * running, i.e. not at the prompt). Returning true means it was consumed.
   */
  onKeyPassthrough?: (event: KeyboardEvent) => boolean;
  /** Forward IME-composed text to the terminal while a program is running. */
  onForwardText?: (text: string) => void;
  /**
   * Navigate the Composer's own sent-history at the prompt, recalling an entry
   * into the draft. Returning true means an entry replaced the draft.
   */
  onHistory?: (direction: "prev" | "next") => boolean;
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
 *
 * There is no Send button: plain Enter submits, Shift+Enter inserts a newline.
 * `data-can-send` reflects whether Enter would submit right now (used by tests
 * and any external affordance in place of a disabled button).
 *
 * Height is resized by dragging the top edge upward (not a textarea corner grip),
 * and the chosen height persists as a desktop UI preference.
 */
export function TerminalInputComposer({
  mode,
  text,
  labels,
  inFlight = false,
  disabled = false,
  commitDisabled = false,
  autoFocus = false,
  atShellPrompt = true,
  textareaRef,
  onTextChange,
  onSend,
  onKeyPassthrough,
  onForwardText,
  onHistory,
  className,
  testId,
}: TerminalInputComposerProps) {
  const compositionActiveRef = useRef(false);
  const actionDisabled = disabled || commitDisabled || inFlight;
  const childTestId = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);

  const [height, setHeightState] = useState(() => readComposerHeight());
  const heightRef = useRef(height);
  const setHeight = (px: number) => {
    const clamped = clampComposerHeight(px);
    heightRef.current = clamped;
    setHeightState(clamped);
  };
  // Drag the top edge: moving the pointer up (smaller clientY) grows the editor.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const onHandlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: heightRef.current };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture unsupported (e.g. jsdom) */
    }
  };
  const onHandlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setHeight(drag.startHeight + (drag.startY - event.clientY));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    writeComposerHeight(heightRef.current);
  };

  useEffect(() => {
    if (mode !== "composer") compositionActiveRef.current = false;
  }, [mode]);

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Composition keys always belong to the IME. At the prompt they build the
    // draft; while a program runs the composed text is forwarded on commit.
    const composing =
      compositionActiveRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229;
    if (composing) return;

    if (!atShellPrompt) {
      // A program owns the screen — forward every key to it (menus, TUIs, and
      // their own history all behave natively).
      if (onKeyPassthrough?.(event.nativeEvent)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    // At the prompt the Composer owns editing. ↑/↓ at the draft's edges recall
    // the Composer's own history instead of the shell's (which would land on the
    // terminal line, detached from this editor).
    const ta = event.currentTarget;
    if (event.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      if (onHistory?.("prev")) {
        event.preventDefault();
        return;
      }
    } else if (
      event.key === "ArrowDown" &&
      ta.selectionStart === ta.value.length &&
      ta.selectionEnd === ta.value.length
    ) {
      if (onHistory?.("next")) {
        event.preventDefault();
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;

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
      data-can-send={actionDisabled ? "false" : "true"}
      aria-busy={inFlight}
      aria-disabled={disabled || undefined}
      className={joinClassNames("terminal-input-composer flex min-w-0 flex-col", className)}
      style={{
        height: `${height}px`,
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
      }}
    >
      <div
        data-testid={childTestId("resize")}
        role="separator"
        aria-orientation="horizontal"
        aria-label={labels.resize}
        className="terminal-input-composer-resize group flex h-1.5 w-full shrink-0 cursor-row-resize items-center justify-center border-t"
        style={{ borderColor: "var(--border)", touchAction: "none" }}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="h-0.5 w-8 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "var(--text-secondary)" }}
        />
      </div>

      <textarea
        ref={textareaRef}
        data-testid={childTestId("textarea")}
        aria-label={labels.editor}
        value={text}
        placeholder={labels.placeholder}
        disabled={disabled}
        autoFocus={autoFocus && !disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="terminal-input-composer-editor min-h-0 w-full min-w-0 flex-1 resize-none border-0 px-2 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          background: "var(--bg-base)",
          color: "var(--text-primary)",
        }}
        onChange={(event) => {
          // While a program runs the editor is a transparent conduit — never stage
          // typed text into the draft. Printable keys are forwarded on keydown;
          // IME-composed text is forwarded on compositionend (below).
          if (!atShellPrompt) {
            if (text !== "") onTextChange("");
            return;
          }
          onTextChange(event.currentTarget.value);
        }}
        onCompositionStart={() => {
          compositionActiveRef.current = true;
        }}
        onCompositionEnd={(event) => {
          compositionActiveRef.current = false;
          if (!atShellPrompt && event.data) {
            onForwardText?.(event.data);
            if (text !== "") onTextChange("");
          }
        }}
        onBlur={() => {
          compositionActiveRef.current = false;
        }}
        onKeyDown={handleEditorKeyDown}
      />
    </div>
  );
}
