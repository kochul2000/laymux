export type InputMode = "direct" | "composer";

export const DESKTOP_INPUT_MODE_STORAGE_KEY = "laymux.desktop.inputMode";
export const DEFAULT_DESKTOP_INPUT_MODE: InputMode = "direct";

type InputModeStorage = Pick<Storage, "getItem" | "setItem">;

export function isInputMode(value: unknown): value is InputMode {
  return value === "direct" || value === "composer";
}

function resolveBrowserStorage(storage?: InputModeStorage | null): InputModeStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the desktop surface preference. Draft text and per-terminal current
 * mode intentionally do not use this storage; only the explicitly selected
 * default mode is persistent.
 */
export function readDesktopInputModePreference(storage?: InputModeStorage | null): InputMode {
  try {
    const stored = resolveBrowserStorage(storage)?.getItem(DESKTOP_INPUT_MODE_STORAGE_KEY);
    return isInputMode(stored) ? stored : DEFAULT_DESKTOP_INPUT_MODE;
  } catch {
    return DEFAULT_DESKTOP_INPUT_MODE;
  }
}

/** Returns false when the value is invalid or browser storage is unavailable. */
export function writeDesktopInputModePreference(
  mode: InputMode,
  storage?: InputModeStorage | null,
): boolean {
  if (!isInputMode(mode)) return false;

  try {
    const target = resolveBrowserStorage(storage);
    if (!target) return false;
    target.setItem(DESKTOP_INPUT_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export const DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY = "laymux.desktop.composerHeight";
export const DEFAULT_COMPOSER_HEIGHT = 96;
export const MIN_COMPOSER_HEIGHT = 56;
export const MAX_COMPOSER_HEIGHT = 480;

/** Keeps a composer height within the draggable bounds; rounds to a whole pixel. */
export function clampComposerHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_COMPOSER_HEIGHT;
  return Math.round(Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, px)));
}

/**
 * Reads the desktop composer editor height (px). Like the input-mode default it
 * is a UI-only surface preference, so it lives in localStorage, not settings.json.
 */
export function readComposerHeight(storage?: InputModeStorage | null): number {
  try {
    const stored = resolveBrowserStorage(storage)?.getItem(DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY);
    const parsed = stored == null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? clampComposerHeight(parsed) : DEFAULT_COMPOSER_HEIGHT;
  } catch {
    return DEFAULT_COMPOSER_HEIGHT;
  }
}

/** Returns false when browser storage is unavailable. Clamps before persisting. */
export function writeComposerHeight(px: number, storage?: InputModeStorage | null): boolean {
  try {
    const target = resolveBrowserStorage(storage);
    if (!target) return false;
    target.setItem(DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY, String(clampComposerHeight(px)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Which terminals share one Composer past-input history bucket ([ADR-0055](../../../docs/adr/0055-composer-history-scope-setting.md)).
 * `global` = every terminal in the app, `workspace` = the terminals of one
 * workspace, `pane` = that terminal alone (the pre-ADR-0055 behavior).
 */
export type ComposerHistoryScope = "global" | "workspace" | "pane";

export const COMPOSER_HISTORY_SCOPES: readonly ComposerHistoryScope[] = [
  "global",
  "workspace",
  "pane",
];

export const DEFAULT_COMPOSER_HISTORY_SCOPE: ComposerHistoryScope = "global";

export function isComposerHistoryScope(value: unknown): value is ComposerHistoryScope {
  return COMPOSER_HISTORY_SCOPES.includes(value as ComposerHistoryScope);
}

declare const composerHistoryKeyBrand: unique symbol;

/**
 * Opaque bucket key. Branded so history reads and writes cannot pass a raw
 * terminal id: every caller must go through `composerHistoryScopeKey`, which is
 * the single derivation point ADR-0055 requires (a read and a write disagreeing
 * on the key would silently split the history).
 */
export type ComposerHistoryKey = string & { readonly [composerHistoryKeyBrand]: true };

export interface ComposerHistoryScopeTarget {
  terminalId: string;
  /** Only consulted for the `workspace` scope. */
  workspaceId?: string | null;
}

/**
 * Resolves the history bucket key for one terminal under the selected scope.
 * A `workspace` scope with no resolvable workspace (dock / app-global terminals)
 * falls back to that terminal's own bucket rather than the shared global one —
 * unknown membership must never widen sharing (ADR-0055 fail-narrow rule).
 */
export function composerHistoryScopeKey(
  scope: ComposerHistoryScope,
  target: ComposerHistoryScopeTarget,
): ComposerHistoryKey {
  const paneKey = `pane:${target.terminalId}` as ComposerHistoryKey;
  if (!isComposerHistoryScope(scope)) return paneKey;
  if (scope === "global") return "global" as ComposerHistoryKey;
  if (scope === "pane") return paneKey;
  return target.workspaceId
    ? (`ws:${target.workspaceId}` as ComposerHistoryKey)
    : /* unresolvable workspace → stay pane-local */ paneKey;
}

const MAX_COMPOSER_HISTORY = 200;
const runtimeHistory = new Map<string, string[]>();

/**
 * Runtime-only history of texts sent from the Composer, per scope bucket. The
 * cap is per bucket regardless of scope, so a `global` bucket ages out faster
 * than a per-pane one would.
 */
export function readComposerHistory(scopeKey: ComposerHistoryKey): string[] {
  return runtimeHistory.get(scopeKey) ?? [];
}

/**
 * Appends a sent draft to the scope's Composer history. Blank entries and
 * consecutive duplicates are ignored; the list is capped so it cannot grow
 * without bound.
 */
export function pushComposerHistory(scopeKey: ComposerHistoryKey, text: string): void {
  if (!text) return;
  const list = runtimeHistory.get(scopeKey) ?? [];
  if (list[list.length - 1] === text) return;
  list.push(text);
  if (list.length > MAX_COMPOSER_HISTORY) list.splice(0, list.length - MAX_COMPOSER_HISTORY);
  runtimeHistory.set(scopeKey, list);
}

/**
 * Drops a deleted workspace's shared bucket. Called from the workspace store —
 * shared buckets outlive individual panes, so nothing else would collect them
 * before the next WebView reload.
 */
export function clearComposerHistoryForWorkspace(workspaceId: string): void {
  runtimeHistory.delete(composerHistoryScopeKey("workspace", { terminalId: "", workspaceId }));
}

/**
 * Default number of past entries shown in the Tab-triggered Composer history
 * popup (issue #504). Kept small so the floating list never obscures much of
 * the terminal above the composer.
 */
export const DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS = 8;

/**
 * Most-recent-first, de-duplicated view of a terminal's Composer history for the
 * Tab-triggered recall popup. `history` is stored oldest→newest; the popup shows
 * the newest first, drops repeats (keeping the most recent occurrence), skips
 * blanks, and caps the list at `max` so it stays a compact, single-screen list.
 */
export function selectComposerHistoryEntries(
  history: readonly string[],
  max = DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
): string[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
    if (entries.length >= max) break;
  }
  return entries;
}

/**
 * Default number of suggestions shown in the as-you-type Composer autocomplete
 * dropdown (issue #505). Kept small for the same reason as the Tab popup.
 */
export const DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS = 8;

/** Long-press delay that opens the starred-entry editor from an autocomplete row. */
export const COMPOSER_STARRED_EDITOR_LONG_PRESS_MS = 500;

/** Host-global persisted Composer shortcut (ADR-0229). */
export type ComposerStarredEntry = {
  value: string;
  label: string;
  send: boolean;
};

/** One as-you-type suggestion: history rows have empty label and send=false. */
export type ComposerAutocompleteSuggestion = {
  value: string;
  label: string;
  send: boolean;
};

export type ComposerStarredEntryInput = string | Partial<ComposerStarredEntry> | null | undefined;

export function composerStarredEntryValue(entry: ComposerStarredEntryInput): string {
  if (typeof entry === "string") return entry;
  return typeof entry?.value === "string" ? entry.value : "";
}

export function normalizeComposerStarredEntry(
  raw: ComposerStarredEntryInput,
): ComposerStarredEntry | null {
  if (typeof raw === "string") {
    if (!raw) return null;
    return { value: raw, label: "", send: false };
  }
  if (!raw || typeof raw !== "object") return null;
  const value = typeof raw.value === "string" ? raw.value : "";
  if (!value) return null;
  return {
    value,
    label: typeof raw.label === "string" ? raw.label : "",
    send: raw.send === true,
  };
}

export function normalizeComposerStarredEntries(
  raw: readonly ComposerStarredEntryInput[] | null | undefined,
): ComposerStarredEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: ComposerStarredEntry[] = [];
  for (const item of raw) {
    const entry = normalizeComposerStarredEntry(item);
    if (!entry || seen.has(entry.value)) continue;
    seen.add(entry.value);
    entries.push(entry);
  }
  return entries;
}

export function isComposerStarred(
  entries: readonly ComposerStarredEntryInput[] | null | undefined,
  value: string,
): boolean {
  if (!value) return false;
  return (entries ?? []).some((entry) => composerStarredEntryValue(entry) === value);
}

export function composerSuggestionDisplay(suggestion: { label: string; value: string }): string {
  const label = suggestion.label.trim();
  return label || suggestion.value;
}

/**
 * As-you-type autocomplete suggestions for the Composer (issue #505, ADR-0229).
 * Starred objects are newest-first and beat runtime history. A row matches the
 * query on value or label prefix (case-insensitive). Exact value matches are
 * skipped unless `send` is set — then picking still submits. An empty query
 * yields nothing so this list never shares the Tab recall popup.
 */
export function selectComposerAutocompleteSuggestions(
  history: readonly string[],
  query: string,
  max = DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  starredEntries: readonly ComposerStarredEntryInput[] = [],
): ComposerAutocompleteSuggestion[] {
  if (max <= 0 || query.length === 0) return [];
  const needle = query.toLowerCase();
  const seen = new Set<string>();
  const entries: ComposerAutocompleteSuggestion[] = [];
  const consider = (value: string, label: string, send: boolean): boolean => {
    if (!value || seen.has(value)) return false;
    if (value === query && !send) return false;
    const valueMatch = value.toLowerCase().startsWith(needle);
    const normalizedLabel = label.trim();
    const labelMatch =
      normalizedLabel.length > 0 && normalizedLabel.toLowerCase().startsWith(needle);
    if (!valueMatch && !labelMatch) return false;
    seen.add(value);
    entries.push({ value, label, send });
    return entries.length >= max;
  };
  const starred = normalizeComposerStarredEntries(starredEntries);
  for (let i = starred.length - 1; i >= 0; i -= 1) {
    const entry = starred[i];
    if (consider(entry.value, entry.label, entry.send)) return entries;
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (consider(history[i] ?? "", "", false)) return entries;
  }
  return entries;
}

export type ComposerSubmissionToken = string;

export interface ComposerSubmissionSnapshot {
  terminalId: string;
  revision: number;
  text: string;
  token: ComposerSubmissionToken;
}

export interface ComposerDraftState {
  text: string;
  revision: number;
  inFlight: ComposerSubmissionSnapshot | null;
}

export interface BeginComposerSubmissionOptions {
  terminalId: string;
  /** Tests and adapters may provide a token; otherwise a runtime-local token is generated. */
  token?: ComposerSubmissionToken;
}

export interface BeginComposerSubmissionResult {
  draft: ComposerDraftState;
  submission: ComposerSubmissionSnapshot;
}

export type ComposerSubmissionOutcome = "success" | "failure" | "cancelled" | "ambiguous";

export interface SettleComposerSubmissionOptions {
  token: ComposerSubmissionToken;
  outcome: ComposerSubmissionOutcome;
}

let nextSubmissionToken = 0;
const runtimeDrafts = new Map<string, ComposerDraftState>();
const runtimeModes = new Map<string, InputMode>();
/**
 * Desktop-preference value each terminal was seeded with. Pinned on first read
 * so a later preference change cannot retro-flip a terminal the user never
 * touched — and so the value stays a stable `useSyncExternalStore` snapshot.
 */
const runtimeSeededModes = new Map<string, InputMode>();
const runtimeDraftListeners = new Map<string, Set<(draft: ComposerDraftState) => void>>();
const runtimeModeListeners = new Map<string, Set<() => void>>();

function notifyRuntimeComposerDraft(terminalId: string, draft: ComposerDraftState): void {
  for (const listener of runtimeDraftListeners.get(terminalId) ?? []) listener(draft);
}

function notifyRuntimeInputMode(terminalId: string): void {
  for (const listener of runtimeModeListeners.get(terminalId) ?? []) listener();
}

function subscribeRuntimeMap<L>(
  listeners: Map<string, Set<L>>,
  terminalId: string,
  listener: L,
): () => void {
  let bucket = listeners.get(terminalId);
  if (!bucket) {
    bucket = new Set();
    listeners.set(terminalId, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket?.delete(listener);
    if (bucket?.size === 0) listeners.delete(terminalId);
  };
}

export function createComposerSubmissionToken(): ComposerSubmissionToken {
  nextSubmissionToken += 1;
  return `composer-${nextSubmissionToken}`;
}

export function createComposerDraftState(text = ""): ComposerDraftState {
  return { text, revision: 0, inFlight: null };
}

/**
 * The one empty draft handed out for every terminal that has never been
 * written. Every producer in this module returns a fresh object (`{...state}`),
 * so nothing mutates a draft in place and a shared instance is safe — and
 * required, because `useSyncExternalStore` rejects a snapshot whose identity
 * changes on every read. Frozen so an accidental in-place write fails loudly.
 */
const EMPTY_COMPOSER_DRAFT: ComposerDraftState = Object.freeze(createComposerDraftState());

/** Runtime-only terminal state. It intentionally disappears on WebView reload. */
export function readRuntimeComposerDraft(terminalId: string): ComposerDraftState {
  return runtimeDrafts.get(terminalId) ?? EMPTY_COMPOSER_DRAFT;
}

export function writeRuntimeComposerDraft(
  terminalId: string,
  draft: ComposerDraftState,
): ComposerDraftState {
  const previous = runtimeDrafts.get(terminalId);
  runtimeDrafts.set(terminalId, draft);
  if (previous !== draft) notifyRuntimeComposerDraft(terminalId, draft);
  return draft;
}

/**
 * Subscribes a mounted surface to runtime-only updates for one terminal.
 * This keeps a replacement mount in sync when an async submission settles in
 * the closure of the surface that originally started it.
 */
export function subscribeRuntimeComposerDraft(
  terminalId: string,
  listener: (draft: ComposerDraftState) => void,
): () => void {
  return subscribeRuntimeMap(runtimeDraftListeners, terminalId, listener);
}

/**
 * Store-shaped counterpart of {@link subscribeRuntimeComposerDraft} for the
 * per-terminal input mode. The listener takes no argument so it can be handed
 * straight to `useSyncExternalStore`, which re-reads
 * {@link readRuntimeInputMode} itself.
 */
export function subscribeRuntimeInputMode(terminalId: string, listener: () => void): () => void {
  return subscribeRuntimeMap(runtimeModeListeners, terminalId, listener);
}

export function readRuntimeInputMode(terminalId: string): InputMode {
  const explicit = runtimeModes.get(terminalId);
  if (explicit !== undefined) return explicit;
  let seeded = runtimeSeededModes.get(terminalId);
  if (seeded === undefined) {
    seeded = readDesktopInputModePreference();
    runtimeSeededModes.set(terminalId, seeded);
  }
  return seeded;
}

export function writeRuntimeInputMode(terminalId: string, mode: InputMode): InputMode {
  const previous = runtimeModes.get(terminalId);
  runtimeModes.set(terminalId, mode);
  if (previous !== mode) notifyRuntimeInputMode(terminalId);
  return mode;
}

/**
 * Test and explicit terminal-close hook; never called for a temporary unmount.
 * Closing one terminal drops only its own pane bucket — a `workspace`/`global`
 * bucket is shared, so clearing it here would wipe other panes' recall.
 */
export function clearRuntimeComposerState(terminalId?: string): void {
  if (terminalId === undefined) {
    const subscribedDraftIds = [...runtimeDraftListeners.keys()];
    const subscribedModeIds = [...runtimeModeListeners.keys()];
    runtimeDrafts.clear();
    runtimeModes.clear();
    runtimeSeededModes.clear();
    runtimeHistory.clear();
    for (const subscribedTerminalId of subscribedDraftIds) {
      notifyRuntimeComposerDraft(subscribedTerminalId, EMPTY_COMPOSER_DRAFT);
    }
    for (const subscribedTerminalId of subscribedModeIds) {
      notifyRuntimeInputMode(subscribedTerminalId);
    }
    return;
  }
  runtimeDrafts.delete(terminalId);
  runtimeModes.delete(terminalId);
  runtimeSeededModes.delete(terminalId);
  runtimeHistory.delete(composerHistoryScopeKey("pane", { terminalId }));
  notifyRuntimeComposerDraft(terminalId, EMPTY_COMPOSER_DRAFT);
  notifyRuntimeInputMode(terminalId);
}

/** Editing stays available while a submission is in flight. */
export function updateComposerDraftText(
  state: ComposerDraftState,
  text: string,
): ComposerDraftState {
  if (state.text === text) return state;
  return { ...state, text, revision: state.revision + 1 };
}

/**
 * Who owns the keyboard in composer mode — the single rule behind every routing
 * decision on this surface (issues #558, #560).
 *
 * **An empty draft lends the keyboard out; a non-empty draft keeps it.** The empty
 * case already forwarded nav keys and control chords so shell history and Ctrl+C
 * kept working; a fullscreen (alternate-screen) app widens that set to *every* key,
 * because such an app is the only thing on screen and every key is meant for it —
 * that is why ASCII reaches vim as it is typed, with no Enter.
 *
 * Non-empty is what makes the rule safe. Text sitting in the draft is visible, and
 * the keys that submit it (Enter) or erase it (Backspace) stay the draft's, so it
 * always has a way out. Without that half, anything that reached the draft while a
 * fullscreen app ran became an orphan: unsubmittable and unerasable, because every
 * key went to the app (issue #560).
 *
 * The corollary is that every route *into* the draft must respect the same rule.
 * Paste, the Shift+Enter newline gesture, and the Tab recall popup all bypass the
 * keydown passthrough, so each one checks this predicate rather than assuming the
 * draft is a valid destination.
 */
export function isComposerKeyProxyActive(input: {
  /** A fullscreen app owns the screen (xterm reports the alternate buffer). */
  altScreen: boolean;
  draftEmpty: boolean;
}): boolean {
  return input.altScreen && input.draftEmpty;
}

/**
 * Where a just-finished IME composition belongs (issue #558).
 *
 * A composition cannot be forwarded key by key — it belongs to the textarea, so the
 * composer's keydown handler deliberately skips passthrough while `isComposing` is
 * set. Forward the *result* instead: in a proxying pane the committed text goes
 * straight to the PTY and leaves the draft, so a fullscreen app receives Korean
 * exactly the way it receives ASCII.
 *
 * Returns `null` when the composition belongs to the draft after all:
 *  - not the alternate screen — the draft is a real drafting surface there, and Enter
 *    submits it (the normal composer flow).
 *  - empty `data` — the IME cancelled rather than committed. Same rule as the
 *    terminal-side blur commit: we never invent text the IME did not hand us.
 *  - the draft held text before this composition — then the user is drafting, the
 *    keyboard is the draft's (`isComposerKeyProxyActive`), and diverting the syllable
 *    would tear one sentence across two destinations.
 */
export function resolveComposerCompositionCommit(input: {
  altScreen: boolean;
  /** `compositionend`'s own data — the authority on commit vs cancel. */
  data: string;
  /** Current draft text, which still holds the composed run. */
  draft: string;
}): { pty: string } | null {
  if (!input.data) return null;
  // What the draft held before this composition. The composed run is at the caret,
  // i.e. the end of the draft — except that some IMEs deliver the final `input`
  // event *after* `compositionend`, leaving the draft one keystroke behind. A draft
  // that is a prefix of the commit is that lag, not user text.
  const priorDraft = input.draft.endsWith(input.data)
    ? input.draft.slice(0, input.draft.length - input.data.length)
    : input.data.startsWith(input.draft)
      ? ""
      : input.draft;
  if (!isComposerKeyProxyActive({ altScreen: input.altScreen, draftEmpty: priorDraft === "" })) {
    return null;
  }
  return { pty: input.data };
}
/**
 * Atomically captures the current draft. A second action is rejected until
 * the matching token settles, preventing key-repeat and double-click sends.
 */
export function beginComposerSubmission(
  state: ComposerDraftState,
  options: BeginComposerSubmissionOptions,
): BeginComposerSubmissionResult | null {
  if (state.inFlight) return null;

  const submission: ComposerSubmissionSnapshot = {
    terminalId: options.terminalId,
    revision: state.revision,
    text: state.text,
    token: options.token ?? createComposerSubmissionToken(),
  };

  return {
    submission,
    draft: { ...state, inFlight: submission },
  };
}

/**
 * Applies only the currently active token. Success clears the draft when its
 * text and revision still equal the captured snapshot; all other outcomes
 * preserve user text and merely release the in-flight action gate.
 */
export function settleComposerSubmission(
  state: ComposerDraftState,
  options: SettleComposerSubmissionOptions,
): ComposerDraftState {
  const submission = state.inFlight;
  if (!submission || submission.token !== options.token) return state;

  const unchanged = state.revision === submission.revision && state.text === submission.text;
  if (options.outcome === "success" && unchanged) {
    return {
      text: "",
      revision: state.text === "" ? state.revision : state.revision + 1,
      inFlight: null,
    };
  }

  return { ...state, inFlight: null };
}
