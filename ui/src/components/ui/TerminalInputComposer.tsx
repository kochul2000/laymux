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
  selectComposerHistoryEntries,
  selectComposerAutocompleteSuggestions,
  DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  writeComposerHeight,
  type InputMode,
} from "@/lib/terminal-input-composer-state";

export interface TerminalInputComposerLabels {
  editor: string;
  placeholder: string;
  resize: string;
  /** Accessible name for the Tab-triggered past-input recall list (issue #504). */
  history: string;
  /** Accessible name for the as-you-type autocomplete suggestion list (issue #505). */
  autocomplete: string;
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
   * True at a shell command prompt (OSC 133 input phase). Only then do edge ↑/↓
   * recall Composer history; while a program runs they pass through so its own
   * history / menu selection work. Defaults true.
   */
  atShellPrompt?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onTextChange: (text: string) => void;
  onSend: () => void;
  /**
   * Give the host a chance to forward a keystroke straight to the terminal
   * (empty-draft nav keys, or any key while a full-screen app runs). Returning
   * true means the host consumed it and the editor should ignore it.
   */
  onKeyPassthrough?: (event: KeyboardEvent, ctx: { empty: boolean }) => boolean;
  /**
   * Recall the Composer's own sent-history into the draft at the prompt (edge
   * ↑/↓). Returning true means the key was consumed.
   */
  onHistory?: (direction: "prev" | "next") => boolean;
  /**
   * Enables the Tab-triggered past-input recall popup (issue #504). When true and
   * the focused draft is empty, Tab opens a list of `history` entries instead of
   * forwarding \t to the terminal.
   */
  historyPopupEnabled?: boolean;
  /** Sent-input history for this terminal, oldest→newest. Used by both recall paths. */
  history?: readonly string[];
  /** Maximum number of entries shown in the popup. */
  maxHistoryItems?: number;
  /**
   * Enables as-you-type autocomplete (issue #505). When true and the focused
   * draft is non-empty, a dropdown of prefix-matching past `history` entries
   * appears; Tab (or arrows + Enter) accepts one.
   */
  autocompleteEnabled?: boolean;
  /** Maximum number of suggestions shown in the autocomplete dropdown. */
  maxAutocompleteItems?: number;
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
  onHistory,
  historyPopupEnabled = false,
  history,
  maxHistoryItems = DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  autocompleteEnabled = false,
  maxAutocompleteItems = DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  className,
  testId,
}: TerminalInputComposerProps) {
  const compositionActiveRef = useRef(false);
  const actionDisabled = disabled || commitDisabled || inFlight;
  const childTestId = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);

  // Tab-triggered past-input recall popup (issue #504). The list is derived from
  // the terminal's runtime Composer history; the popup only opens on an empty,
  // focused draft, so it never fights normal typing or shell tab-completion.
  const historyEntries =
    historyPopupEnabled && text.length === 0
      ? selectComposerHistoryEntries(history ?? [], maxHistoryItems)
      : [];
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Derived so the popup can never linger once its list empties (draft typed
  // into, setting turned off, history cleared) — no reconciling effect needed.
  const historyVisible = historyOpen && historyEntries.length > 0;
  const closeHistory = () => setHistoryOpen(false);
  const commitHistoryEntry = (entry: string | undefined) => {
    setHistoryOpen(false);
    if (entry != null) onTextChange(entry);
  };

  // As-you-type autocomplete (issue #505). Suggestions are prefix matches of the
  // non-empty draft against the same runtime history the Tab popup reads. Because
  // this needs a non-empty draft and the Tab popup needs an empty one, the two
  // lists are mutually exclusive by construction and never fight for keys.
  const autocompleteSuggestions =
    autocompleteEnabled && text.length > 0
      ? selectComposerAutocompleteSuggestions(history ?? [], text, maxAutocompleteItems)
      : [];
  // Escape / blur dismiss the dropdown until the next keystroke reopens it.
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false);
  // -1 means "no active suggestion": the dropdown is showing but has not stolen
  // Enter, so plain Enter still sends. Arrows move a real selection in.
  const [autocompleteIndex, setAutocompleteIndex] = useState(-1);
  const autocompleteVisible = !autocompleteDismissed && autocompleteSuggestions.length > 0;
  // Clamp defensively: the draft can shrink the list between renders.
  const activeAutocompleteIndex =
    autocompleteIndex >= 0 && autocompleteIndex < autocompleteSuggestions.length
      ? autocompleteIndex
      : -1;
  const dismissAutocomplete = () => {
    setAutocompleteDismissed(true);
    setAutocompleteIndex(-1);
  };
  const commitAutocompleteEntry = (entry: string | undefined) => {
    dismissAutocomplete();
    if (entry != null) onTextChange(entry);
  };

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
    // Composition keys always belong to the IME, never to passthrough or Send.
    const composing =
      compositionActiveRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229;
    // History recall only fires on an unmodified arrow: modifier combos are app
    // keybindings (or selection gestures) — the host's registry check routes them.
    const plainKey = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

    // While the Tab recall popup is open it owns navigation/commit keys so they
    // never leak to edge history recall, passthrough, or Send.
    if (historyVisible && !composing) {
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        setHistoryIndex((i) => (i + 1) % historyEntries.length);
        return;
      }
      if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        setHistoryIndex((i) => (i - 1 + historyEntries.length) % historyEntries.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commitHistoryEntry(historyEntries[historyIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeHistory();
        return;
      }
    }

    // While the as-you-type autocomplete dropdown is open it owns Tab/Escape and,
    // once a suggestion is navigated to, Enter/arrows. With no active selection it
    // deliberately does NOT consume Enter or a bare ArrowUp, so plain Enter still
    // sends and edge ↑/↓ recall keeps working (mutually exclusive with #504's Tab
    // popup, which only opens on an empty draft).
    if (autocompleteVisible && !composing && plainKey) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAutocompleteIndex((i) => Math.min(i + 1, autocompleteSuggestions.length - 1));
        return;
      }
      if (event.key === "ArrowUp" && activeAutocompleteIndex >= 0) {
        event.preventDefault();
        // Leaving the list at the top (index 0 → -1) keeps the dropdown open but
        // reselects the draft, restoring plain-Enter send.
        setAutocompleteIndex(activeAutocompleteIndex - 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissAutocomplete();
        return;
      }
      if (event.key === "Tab") {
        // Tab accepts the active suggestion, or the top one if none is active —
        // the "type a prefix, Tab to complete" gesture.
        event.preventDefault();
        event.stopPropagation();
        commitAutocompleteEntry(
          autocompleteSuggestions[activeAutocompleteIndex >= 0 ? activeAutocompleteIndex : 0],
        );
        return;
      }
      if (event.key === "Enter" && activeAutocompleteIndex >= 0) {
        event.preventDefault();
        commitAutocompleteEntry(autocompleteSuggestions[activeAutocompleteIndex]);
        return;
      }
    }

    // Tab on an empty, focused draft opens the past-input recall popup instead of
    // forwarding \t (which does nothing useful with no text to complete).
    if (
      !historyVisible &&
      !composing &&
      plainKey &&
      event.key === "Tab" &&
      historyEntries.length > 0
    ) {
      event.preventDefault();
      event.stopPropagation();
      setHistoryIndex(0);
      setHistoryOpen(true);
      return;
    }

    // At the shell prompt, edge ↑/↓ recall the Composer's own history into the
    // editor (editable), instead of leaking ↑ to the shell where the recalled
    // command would land on the terminal line, detached from this editor.
    if (atShellPrompt && !composing && plainKey) {
      const ta = event.currentTarget;
      if (event.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        onHistory?.("prev");
        event.preventDefault();
        return;
      }
      if (
        event.key === "ArrowDown" &&
        ta.selectionStart === ta.value.length &&
        ta.selectionEnd === ta.value.length
      ) {
        onHistory?.("next");
        event.preventDefault();
        return;
      }
    }

    // Shift+Enter is always the newline gesture (even on an empty draft, to start
    // a multiline one) — never offer it for passthrough.
    const newlineGesture = event.key === "Enter" && event.shiftKey;

    // Let the host forward empty-draft nav/control keys / full-screen-app keys
    // to the PTY. The host checks laymux keybindings first (rebind-aware).
    if (
      !composing &&
      !newlineGesture &&
      onKeyPassthrough?.(event.nativeEvent, { empty: text.length === 0 })
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing) return;

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
      className={joinClassNames(
        "terminal-input-composer relative flex min-w-0 flex-col",
        className,
      )}
      style={{
        height: `${height}px`,
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
      }}
    >
      {historyVisible && (
        <ul
          data-testid={childTestId("history")}
          role="listbox"
          aria-label={labels.history}
          className="terminal-input-composer-history absolute inset-x-0 bottom-full z-10 m-0 max-h-48 list-none overflow-y-auto border-t p-1 text-sm shadow-lg"
          style={{
            background: "var(--bg-overlay)",
            borderColor: "var(--border)",
            color: "var(--text-primary)",
          }}
        >
          {historyEntries.map((entry, index) => (
            <li
              // Entries can repeat only across different indices post-dedupe, so
              // index is a stable key for this ephemeral list.
              key={`${index}-${entry}`}
              id={`${childTestId("history")}-option-${index}`}
              data-testid={childTestId(`history-option-${index}`)}
              role="option"
              aria-selected={index === historyIndex}
              title={entry}
              className="terminal-input-composer-history-item cursor-pointer truncate whitespace-nowrap rounded px-2 py-1"
              style={index === historyIndex ? { background: "var(--accent-20)" } : undefined}
              onMouseEnter={() => setHistoryIndex(index)}
              // mousedown (not click) so the textarea keeps focus through the pick.
              onMouseDown={(event) => {
                event.preventDefault();
                commitHistoryEntry(entry);
              }}
            >
              {entry}
            </li>
          ))}
        </ul>
      )}
      {autocompleteVisible && (
        <ul
          data-testid={childTestId("autocomplete")}
          role="listbox"
          aria-label={labels.autocomplete}
          className="terminal-input-composer-history absolute inset-x-0 bottom-full z-10 m-0 max-h-48 list-none overflow-y-auto border-t p-1 text-sm shadow-lg"
          style={{
            background: "var(--bg-overlay)",
            borderColor: "var(--border)",
            color: "var(--text-primary)",
          }}
        >
          {autocompleteSuggestions.map((entry, index) => (
            <li
              // Post-dedupe entries are unique, so the value is a stable key.
              key={`${index}-${entry}`}
              id={`${childTestId("autocomplete")}-option-${index}`}
              data-testid={childTestId(`autocomplete-option-${index}`)}
              role="option"
              aria-selected={index === activeAutocompleteIndex}
              title={entry}
              className="terminal-input-composer-history-item cursor-pointer truncate whitespace-nowrap rounded px-2 py-1"
              style={
                index === activeAutocompleteIndex ? { background: "var(--accent-20)" } : undefined
              }
              onMouseEnter={() => setAutocompleteIndex(index)}
              // mousedown (not click) so the textarea keeps focus through the pick.
              onMouseDown={(event) => {
                event.preventDefault();
                commitAutocompleteEntry(entry);
              }}
            >
              {entry}
            </li>
          ))}
        </ul>
      )}
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
        role="textbox"
        aria-expanded={historyVisible || autocompleteVisible}
        aria-controls={
          historyVisible
            ? childTestId("history")
            : autocompleteVisible
              ? childTestId("autocomplete")
              : undefined
        }
        aria-activedescendant={
          historyVisible
            ? `${childTestId("history")}-option-${historyIndex}`
            : autocompleteVisible && activeAutocompleteIndex >= 0
              ? `${childTestId("autocomplete")}-option-${activeAutocompleteIndex}`
              : undefined
        }
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="terminal-input-composer-editor min-h-0 w-full min-w-0 flex-1 resize-none border-0 px-2 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          background: "var(--bg-base)",
          color: "var(--text-primary)",
        }}
        onChange={(event) => {
          // Any manual edit dismisses the recall popup so it never fights typing.
          if (historyOpen) setHistoryOpen(false);
          // Typing re-arms autocomplete (undo a prior Escape) and clears any active
          // selection so the fresh suggestion list never steals the next Enter.
          if (autocompleteDismissed) setAutocompleteDismissed(false);
          if (autocompleteIndex !== -1) setAutocompleteIndex(-1);
          onTextChange(event.currentTarget.value);
        }}
        onCompositionStart={() => {
          compositionActiveRef.current = true;
        }}
        onCompositionEnd={() => {
          compositionActiveRef.current = false;
        }}
        onBlur={() => {
          compositionActiveRef.current = false;
          // Leaving the editor (pane/mode switch, clicking away) closes both lists.
          setHistoryOpen(false);
          dismissAutocomplete();
        }}
        onKeyDown={handleEditorKeyDown}
      />
    </div>
  );
}
