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
  composerSuggestionDisplay,
  isComposerStarred,
  normalizeComposerStarredEntries,
  COMPOSER_STARRED_EDITOR_LONG_PRESS_MS,
  DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  writeComposerHeight,
  type ComposerStarredEntry,
  type ComposerStarredEntryInput,
  type ComposerAutocompleteSuggestion,
  type InputMode,
} from "@/lib/terminal-input-composer-state";
import { ComposerStarredEntryEditor } from "@/components/ui/ComposerStarredEntryEditor";
import { StarIcon } from "@/components/ui/icons";

export interface TerminalInputComposerLabels {
  editor: string;
  resize: string;
  /** Accessible name for the Tab-triggered past-input recall list (issue #504). */
  history: string;
  /** Accessible name for the as-you-type autocomplete suggestion list (issue #505). */
  autocomplete: string;
  star: string;
  unstar: string;
  starredEditor: string;
  starredLabel: string;
  starredValue: string;
  starredSend: string;
  starredSendDesc: string;
  starredSave: string;
  starredCancel: string;
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
   * Whether the host is currently proxying the keyboard to the terminal
   * (`isComposerKeyProxyActive`). The gestures that reach the draft *without* going
   * through `onKeyPassthrough` — the Shift+Enter newline, the Tab recall popup,
   * paste — ask this first, so nothing lands in a draft that has no way out
   * (issue #560).
   */
  isKeyProxyActive?: (ctx: { empty: boolean }) => boolean;
  /**
   * Paste arrived while the host owns the keyboard, so it belongs to the terminal,
   * not the draft. Receives the clipboard text, as Direct mode's native paste does.
   */
  onProxyPaste?: (text: string) => void;
  /**
   * A composition just committed. The host routes it to the PTY when the pane is
   * proxying keys for a fullscreen app, and trims it out of the draft (issue #558).
   */
  onCompositionCommit?: (data: string) => void;
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
  /** Sent-input history for the active scope bucket, oldest→newest. Used by both recall paths. */
  history?: readonly string[];
  /**
   * Identity of the bucket `history` came from (ADR-0055). A change means the
   * user switched the history scope, so both open lists close instead of
   * indexing into entries that are no longer on screen.
   */
  historyScopeKey?: string;
  /** Maximum number of entries shown in the popup. */
  maxHistoryItems?: number;
  /**
   * Enables as-you-type autocomplete (issue #505). When true and the focused
   * draft is non-empty, a dropdown of prefix-matching past `history` entries
   * appears; Tab (or arrows + Enter) accepts one.
   */
  autocompleteEnabled?: boolean;
  /** Host-global explicitly persisted entries (ADR-0226, ADR-0229). */
  starredEntries?: readonly ComposerStarredEntryInput[];
  onToggleStar?: (entry: string, starred: boolean) => void;
  onUpsertStarredEntry?: (entry: ComposerStarredEntry, previousValue?: string) => void;
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
  isKeyProxyActive,
  onProxyPaste,
  onCompositionCommit,
  onHistory,
  historyPopupEnabled = false,
  history,
  historyScopeKey,
  maxHistoryItems = DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  autocompleteEnabled = false,
  starredEntries = [],
  onToggleStar,
  onUpsertStarredEntry,
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
  // Both lists tag their open/highlight state with the bucket it was opened
  // against (ADR-0055). A scope switch swaps `history` underneath us, so tying
  // the state to the bucket makes it close and reset by derivation — same
  // "no reconciling effect" approach as the empty-list case below.
  const historyBucket = historyScopeKey ?? null;
  const [historyOpenBucket, setHistoryOpenBucket] = useState<{ key: string | null } | null>(null);
  const [historyCursor, setHistoryCursor] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  });
  const historyOpen = historyOpenBucket !== null && historyOpenBucket.key === historyBucket;
  const historyIndex = historyCursor.key === historyBucket ? historyCursor.index : 0;
  const setHistoryIndex = (next: number | ((prev: number) => number)) =>
    setHistoryCursor((prev) => {
      const base = prev.key === historyBucket ? prev.index : 0;
      return { key: historyBucket, index: typeof next === "function" ? next(base) : next };
    });
  // Derived so the popup can never linger once its list empties (draft typed
  // into, setting turned off, history cleared) — no reconciling effect needed.
  const historyVisible = historyOpen && historyEntries.length > 0;
  const openHistory = () => setHistoryOpenBucket({ key: historyBucket });
  const closeHistory = () => setHistoryOpenBucket(null);
  const commitHistoryEntry = (entry: string | undefined) => {
    closeHistory();
    if (entry != null) onTextChange(entry);
  };

  // As-you-type autocomplete (issue #505). Suggestions are prefix matches of the
  // non-empty draft against the same runtime history the Tab popup reads. Because
  // this needs a non-empty draft and the Tab popup needs an empty one, the two
  // lists are mutually exclusive by construction and never fight for keys.
  const autocompleteSuggestions =
    autocompleteEnabled && text.length > 0
      ? selectComposerAutocompleteSuggestions(
          history ?? [],
          text,
          maxAutocompleteItems,
          starredEntries,
        )
      : [];
  // Escape / blur dismiss the dropdown until the next keystroke reopens it.
  // Bucket-tagged like the popup state: a scope switch re-arms it.
  const [autocompleteDismissedBucket, setAutocompleteDismissedBucket] = useState<{
    key: string | null;
  } | null>(null);
  const autocompleteDismissed =
    autocompleteDismissedBucket !== null && autocompleteDismissedBucket.key === historyBucket;
  const setAutocompleteDismissed = (dismissed: boolean) =>
    setAutocompleteDismissedBucket(dismissed ? { key: historyBucket } : null);
  // -1 means "no active suggestion": the dropdown is showing but has not stolen
  // Enter, so plain Enter still sends. Arrows move a real selection in.
  const [autocompleteCursor, setAutocompleteCursor] = useState<{
    key: string | null;
    index: number;
  }>({ key: null, index: -1 });
  const autocompleteIndex =
    autocompleteCursor.key === historyBucket ? autocompleteCursor.index : -1;
  const setAutocompleteIndex = (next: number | ((prev: number) => number)) =>
    setAutocompleteCursor((prev) => {
      const base = prev.key === historyBucket ? prev.index : -1;
      return { key: historyBucket, index: typeof next === "function" ? next(base) : next };
    });
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
  const commitAutocompleteEntry = (suggestion: ComposerAutocompleteSuggestion | undefined) => {
    dismissAutocomplete();
    if (suggestion == null) return;
    onTextChange(suggestion.value);
    if (suggestion.send && !actionDisabled) onSend();
  };
  const [starredEditor, setStarredEditor] = useState<{
    previousValue?: string;
    entry: ComposerStarredEntry;
  } | null>(null);
  const openStarredEditor = (suggestion: ComposerAutocompleteSuggestion) => {
    if (!onUpsertStarredEntry) return;
    const existing = normalizeComposerStarredEntries(starredEntries).find(
      (entry) => entry.value === suggestion.value,
    );
    dismissAutocomplete();
    setStarredEditor({
      previousValue: existing?.value,
      entry: existing ?? {
        value: suggestion.value,
        label: suggestion.label,
        send: suggestion.send,
      },
    });
  };

  const renderStarButton = (entry: string) => {
    const starred = isComposerStarred(starredEntries, entry);
    const action = starred ? labels.unstar : labels.star;
    if (!onToggleStar) return null;
    return (
      <button
        type="button"
        aria-label={`${action}: ${entry}`}
        aria-pressed={starred}
        title={action}
        className="shrink-0 rounded p-0.5"
        style={{ color: starred ? "var(--accent)" : "var(--text-secondary)" }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar(entry, !starred);
        }}
      >
        <StarIcon size={13} fill={starred ? "currentColor" : "none"} />
      </button>
    );
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

  /**
   * See `isComposerKeyProxyActive`: an empty draft lends the keyboard to the host.
   * `live` is the textarea's own value, used where an event carries it — a controlled
   * `text` prop is one render behind an edit, and answering "is the draft empty" from
   * a stale value routes the gesture to the wrong destination.
   */
  const keyProxyActive = (live?: string) =>
    isKeyProxyActive?.({ empty: (live ?? text).length === 0 }) ?? false;

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
      historyEntries.length > 0 &&
      // \t is a real key for a fullscreen app, and a recalled entry would land in a
      // draft with no way out while the host owns the keyboard (issue #560).
      !keyProxyActive()
    ) {
      event.preventDefault();
      event.stopPropagation();
      setHistoryIndex(0);
      openHistory();
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

    // Shift+Enter is the newline gesture (even on an empty draft, to start a
    // multiline one) — never offered for passthrough. Except while the host owns the
    // keyboard: a draft started there would be stranded, since the keys that submit
    // or erase it belong to the app (issue #560). Then it passes through as Enter.
    const newlineGesture = event.key === "Enter" && event.shiftKey && !keyProxyActive();

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
          id={childTestId("history")}
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
              role="none"
              className="terminal-input-composer-history-item flex items-center gap-1 rounded"
              style={index === historyIndex ? { background: "var(--accent-20)" } : undefined}
              onMouseEnter={() => setHistoryIndex(index)}
            >
              <button
                type="button"
                id={`${childTestId("history")}-option-${index}`}
                data-testid={childTestId(`history-option-${index}`)}
                role="option"
                aria-selected={index === historyIndex}
                title={entry}
                className="min-w-0 flex-1 cursor-pointer truncate whitespace-nowrap px-2 py-1 text-left"
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitHistoryEntry(entry);
                }}
              >
                {entry}
              </button>
              {renderStarButton(entry)}
            </li>
          ))}
        </ul>
      )}
      {autocompleteVisible && (
        <ul
          data-testid={childTestId("autocomplete")}
          id={childTestId("autocomplete")}
          role="listbox"
          aria-label={labels.autocomplete}
          className="terminal-input-composer-history absolute inset-x-0 bottom-full z-10 m-0 max-h-48 list-none overflow-y-auto border-t p-1 text-sm shadow-lg"
          style={{
            background: "var(--bg-overlay)",
            borderColor: "var(--border)",
            color: "var(--text-primary)",
          }}
        >
          {autocompleteSuggestions.map((suggestion, index) => (
            <li
              // Post-dedupe entries are unique, so the value is a stable key.
              key={`${index}-${suggestion.value}`}
              role="none"
              className="terminal-input-composer-history-item flex items-center gap-1 rounded"
              style={
                index === activeAutocompleteIndex ? { background: "var(--accent-20)" } : undefined
              }
              onMouseEnter={() => setAutocompleteIndex(index)}
            >
              <button
                type="button"
                id={`${childTestId("autocomplete")}-option-${index}`}
                data-testid={childTestId(`autocomplete-option-${index}`)}
                role="option"
                aria-selected={index === activeAutocompleteIndex}
                title={suggestion.value}
                className="min-w-0 flex-1 cursor-pointer truncate whitespace-nowrap px-2 py-1 text-left"
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  if (!onUpsertStarredEntry) commitAutocompleteEntry(suggestion);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  if (event.isPrimary === false && event.pointerType) return;
                  if (!onUpsertStarredEntry) return;
                  const target = event.currentTarget;
                  const pointerId = event.pointerId;
                  const startX = event.clientX;
                  const startY = event.clientY;
                  let fired = false;
                  let moved = false;
                  try {
                    target.setPointerCapture(pointerId);
                  } catch {
                    /* jsdom */
                  }
                  const timer = window.setTimeout(() => {
                    fired = true;
                    openStarredEditor(suggestion);
                  }, COMPOSER_STARRED_EDITOR_LONG_PRESS_MS);
                  const stop = () => {
                    window.clearTimeout(timer);
                    try {
                      target.releasePointerCapture(pointerId);
                    } catch {
                      /* already released */
                    }
                    target.removeEventListener("pointerup", onUp);
                    target.removeEventListener("pointercancel", onCancel);
                    target.removeEventListener("pointermove", onMove);
                  };
                  const onMove = (move: globalThis.PointerEvent) => {
                    if (move.pointerId !== pointerId) return;
                    if (Math.hypot(move.clientX - startX, move.clientY - startY) > 8) {
                      moved = true;
                      stop();
                    }
                  };
                  const onUp = (up: globalThis.PointerEvent) => {
                    if (up.pointerId !== pointerId) return;
                    stop();
                    if (fired || moved) return;
                    up.preventDefault();
                    commitAutocompleteEntry(suggestion);
                  };
                  const onCancel = (cancel: globalThis.PointerEvent) => {
                    if (cancel.pointerId !== pointerId) return;
                    stop();
                  };
                  target.addEventListener("pointerup", onUp);
                  target.addEventListener("pointercancel", onCancel);
                  target.addEventListener("pointermove", onMove);
                }}
              >
                {composerSuggestionDisplay(suggestion)}
                {suggestion.send ? (
                  <span
                    aria-hidden="true"
                    className="ml-1"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    ↵
                  </span>
                ) : null}
              </button>
              {renderStarButton(suggestion.value)}
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
        disabled={disabled}
        autoFocus={autoFocus && !disabled}
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
          if (historyOpen) closeHistory();
          // Typing re-arms autocomplete (undo a prior Escape) and clears any active
          // selection so the fresh suggestion list never steals the next Enter.
          if (autocompleteDismissed) setAutocompleteDismissed(false);
          if (autocompleteIndex !== -1) setAutocompleteIndex(-1);
          onTextChange(event.currentTarget.value);
        }}
        onPaste={(event) => {
          // Paste never passes through keydown, so it needs its own check: while the
          // host owns the keyboard the clipboard belongs to the terminal too, or the
          // pasted text would sit in a draft with no key left to submit or erase it
          // (issue #560). The host runs its own paste pipeline.
          if (!keyProxyActive(event.currentTarget.value)) return;
          const text = event.clipboardData.getData("text/plain");
          event.preventDefault();
          event.stopPropagation();
          if (text) onProxyPaste?.(text);
        }}
        onCompositionStart={() => {
          compositionActiveRef.current = true;
        }}
        onCompositionEnd={(event) => {
          compositionActiveRef.current = false;
          // The host decides whether this commit belongs to the PTY instead of the
          // draft — see `resolveComposerCompositionCommit` (issue #558). Passing the
          // event's own data keeps commit-vs-cancel with the IME.
          onCompositionCommit?.(event.data ?? "");
        }}
        onBlur={() => {
          compositionActiveRef.current = false;
          // Leaving the editor (pane/mode switch, clicking away) closes both lists.
          closeHistory();
          dismissAutocomplete();
        }}
        onKeyDown={handleEditorKeyDown}
      />
      {starredEditor ? (
        <ComposerStarredEntryEditor
          title={labels.starredEditor}
          initial={starredEditor.entry}
          labels={{
            label: labels.starredLabel,
            value: labels.starredValue,
            send: labels.starredSend,
            sendDesc: labels.starredSendDesc,
            save: labels.starredSave,
            cancel: labels.starredCancel,
          }}
          onClose={() => setStarredEditor(null)}
          onSave={(entry) => {
            onUpsertStarredEntry?.(entry, starredEditor.previousValue);
            setStarredEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}
