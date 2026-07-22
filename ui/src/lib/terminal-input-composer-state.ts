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

const MAX_COMPOSER_HISTORY = 200;
const runtimeHistory = new Map<string, string[]>();

/** Runtime-only per-terminal history of texts sent from the Composer. */
export function readComposerHistory(terminalId: string): string[] {
  return runtimeHistory.get(terminalId) ?? [];
}

/**
 * Appends a sent draft to the terminal's Composer history. Blank entries and
 * consecutive duplicates are ignored; the list is capped so it cannot grow
 * without bound.
 */
export function pushComposerHistory(terminalId: string, text: string): void {
  if (!text) return;
  const list = runtimeHistory.get(terminalId) ?? [];
  if (list[list.length - 1] === text) return;
  list.push(text);
  if (list.length > MAX_COMPOSER_HISTORY) list.splice(0, list.length - MAX_COMPOSER_HISTORY);
  runtimeHistory.set(terminalId, list);
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
const runtimeDraftListeners = new Map<string, Set<(draft: ComposerDraftState) => void>>();

function notifyRuntimeComposerDraft(terminalId: string, draft: ComposerDraftState): void {
  for (const listener of runtimeDraftListeners.get(terminalId) ?? []) listener(draft);
}

export function createComposerSubmissionToken(): ComposerSubmissionToken {
  nextSubmissionToken += 1;
  return `composer-${nextSubmissionToken}`;
}

export function createComposerDraftState(text = ""): ComposerDraftState {
  return { text, revision: 0, inFlight: null };
}

/** Runtime-only terminal state. It intentionally disappears on WebView reload. */
export function readRuntimeComposerDraft(terminalId: string): ComposerDraftState {
  return runtimeDrafts.get(terminalId) ?? createComposerDraftState();
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
  let listeners = runtimeDraftListeners.get(terminalId);
  if (!listeners) {
    listeners = new Set();
    runtimeDraftListeners.set(terminalId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) runtimeDraftListeners.delete(terminalId);
  };
}

export function readRuntimeInputMode(terminalId: string): InputMode {
  return runtimeModes.get(terminalId) ?? readDesktopInputModePreference();
}

export function writeRuntimeInputMode(terminalId: string, mode: InputMode): InputMode {
  runtimeModes.set(terminalId, mode);
  return mode;
}

/** Test and explicit terminal-close hook; never called for a temporary unmount. */
export function clearRuntimeComposerState(terminalId?: string): void {
  if (terminalId === undefined) {
    const subscribedTerminalIds = [...runtimeDraftListeners.keys()];
    runtimeDrafts.clear();
    runtimeModes.clear();
    runtimeHistory.clear();
    for (const subscribedTerminalId of subscribedTerminalIds) {
      notifyRuntimeComposerDraft(subscribedTerminalId, createComposerDraftState());
    }
    return;
  }
  runtimeDrafts.delete(terminalId);
  runtimeModes.delete(terminalId);
  runtimeHistory.delete(terminalId);
  notifyRuntimeComposerDraft(terminalId, createComposerDraftState());
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
