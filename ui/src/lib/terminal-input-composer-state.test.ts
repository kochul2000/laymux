import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";
import {
  DEFAULT_COMPOSER_HEIGHT,
  DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY,
  DESKTOP_INPUT_MODE_STORAGE_KEY,
  MAX_COMPOSER_HEIGHT,
  MIN_COMPOSER_HEIGHT,
  beginComposerSubmission,
  clampComposerHeight,
  DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  clearRuntimeComposerState,
  createComposerDraftState,
  pushComposerHistory,
  readComposerHeight,
  readComposerHistory,
  selectComposerHistoryEntries,
  selectComposerAutocompleteSuggestions,
  readDesktopInputModePreference,
  readRuntimeComposerDraft,
  readRuntimeInputMode,
  settleComposerSubmission,
  subscribeRuntimeComposerDraft,
  updateComposerDraftText,
  writeComposerHeight,
  writeDesktopInputModePreference,
  writeRuntimeComposerDraft,
  writeRuntimeInputMode,
} from "./terminal-input-composer-state";

describe("composer sent-history", () => {
  beforeEach(() => {
    clearRuntimeComposerState();
  });

  it("appends entries, skipping blanks and consecutive duplicates", () => {
    pushComposerHistory("t1", "one");
    pushComposerHistory("t1", "one"); // duplicate — ignored
    pushComposerHistory("t1", ""); // blank — ignored
    pushComposerHistory("t1", "two");
    expect(readComposerHistory("t1")).toEqual(["one", "two"]);
  });

  it("isolates history per terminal and clears it with runtime state", () => {
    pushComposerHistory("a", "cmd-a");
    pushComposerHistory("b", "cmd-b");
    expect(readComposerHistory("a")).toEqual(["cmd-a"]);
    clearRuntimeComposerState("a");
    expect(readComposerHistory("a")).toEqual([]);
    expect(readComposerHistory("b")).toEqual(["cmd-b"]);
  });
});

describe("selectComposerHistoryEntries (issue #504 popup view)", () => {
  it("shows the newest entry first", () => {
    expect(selectComposerHistoryEntries(["one", "two", "three"])).toEqual(["three", "two", "one"]);
  });

  it("de-duplicates keeping only the most recent occurrence", () => {
    expect(selectComposerHistoryEntries(["ls", "cd", "ls", "pwd"])).toEqual(["pwd", "ls", "cd"]);
  });

  it("skips blank entries", () => {
    expect(selectComposerHistoryEntries(["a", "", "b"])).toEqual(["b", "a"]);
  });

  it("caps the list at the requested maximum", () => {
    const history = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
    const entries = selectComposerHistoryEntries(history, 3);
    expect(entries).toEqual(["cmd-19", "cmd-18", "cmd-17"]);
  });

  it("defaults to a compact list and returns nothing for a non-positive cap", () => {
    const history = Array.from({ length: 50 }, (_, i) => `cmd-${i}`);
    expect(selectComposerHistoryEntries(history)).toHaveLength(
      DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
    );
    expect(selectComposerHistoryEntries(history, 0)).toEqual([]);
  });

  it("returns an empty list for empty history", () => {
    expect(selectComposerHistoryEntries([])).toEqual([]);
  });
});

describe("selectComposerAutocompleteSuggestions (issue #505)", () => {
  const history = ["npm install", "npm run build", "npm test", "git status", "npm install"];

  it("returns newest-first prefix matches for the current query", () => {
    // History holds two "npm install"; only the most recent occurrence is kept.
    expect(selectComposerAutocompleteSuggestions(history, "npm")).toEqual([
      "npm install",
      "npm test",
      "npm run build",
    ]);
  });

  it("matches case-insensitively while preserving the stored casing", () => {
    expect(selectComposerAutocompleteSuggestions(["Git Push", "git pull"], "git")).toEqual([
      "git pull",
      "Git Push",
    ]);
  });

  it("returns nothing for an empty query — that is the Tab popup's domain", () => {
    expect(selectComposerAutocompleteSuggestions(history, "")).toEqual([]);
  });

  it("excludes an entry that already equals the query exactly", () => {
    // Nothing to complete when the draft is already a full past entry.
    expect(selectComposerAutocompleteSuggestions(["git status"], "git status")).toEqual([]);
  });

  it("returns nothing when no entry starts with the query", () => {
    expect(selectComposerAutocompleteSuggestions(history, "docker")).toEqual([]);
  });

  it("skips blank entries", () => {
    expect(selectComposerAutocompleteSuggestions(["", "ls -la", ""], "ls")).toEqual(["ls -la"]);
  });

  it("caps the list at the requested maximum and returns nothing for a non-positive cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
    expect(selectComposerAutocompleteSuggestions(many, "cmd", 3)).toEqual([
      "cmd-19",
      "cmd-18",
      "cmd-17",
    ]);
    expect(selectComposerAutocompleteSuggestions(many, "cmd", 0)).toEqual([]);
  });

  it("defaults to a compact cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => `cmd-${i}`);
    expect(selectComposerAutocompleteSuggestions(many, "cmd")).toHaveLength(
      DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
    );
  });
});

describe("desktop composer height preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults when unset and clamps to the draggable bounds", () => {
    expect(readComposerHeight()).toBe(DEFAULT_COMPOSER_HEIGHT);
    expect(clampComposerHeight(0)).toBe(MIN_COMPOSER_HEIGHT);
    expect(clampComposerHeight(99999)).toBe(MAX_COMPOSER_HEIGHT);
    expect(clampComposerHeight(Number.NaN)).toBe(DEFAULT_COMPOSER_HEIGHT);
  });

  it("round-trips a clamped height through storage", () => {
    expect(writeComposerHeight(140)).toBe(true);
    expect(localStorage.getItem(DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY)).toBe("140");
    expect(readComposerHeight()).toBe(140);

    writeComposerHeight(10_000);
    expect(readComposerHeight()).toBe(MAX_COMPOSER_HEIGHT);
  });
});

describe("desktop terminal input-mode preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to direct when no preference exists", () => {
    expect(readDesktopInputModePreference()).toBe("direct");
  });

  it("round-trips direct and composer using the ADR storage key", () => {
    expect(writeDesktopInputModePreference("composer")).toBe(true);
    expect(localStorage.getItem(DESKTOP_INPUT_MODE_STORAGE_KEY)).toBe("composer");
    expect(readDesktopInputModePreference()).toBe("composer");

    expect(writeDesktopInputModePreference("direct")).toBe(true);
    expect(readDesktopInputModePreference()).toBe("direct");
  });

  it("rejects unknown persisted and written values", () => {
    localStorage.setItem(DESKTOP_INPUT_MODE_STORAGE_KEY, "warp");
    expect(readDesktopInputModePreference()).toBe("direct");

    expect(writeDesktopInputModePreference("warp" as never)).toBe(false);
    expect(localStorage.getItem(DESKTOP_INPUT_MODE_STORAGE_KEY)).toBe("warp");
  });

  it("fails safely when storage access throws", () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readDesktopInputModePreference(brokenStorage)).toBe("direct");
    expect(writeDesktopInputModePreference("composer", brokenStorage)).toBe(false);
  });
});

describe("runtime-only terminal composer state", () => {
  beforeEach(() => {
    localStorage.clear();
    clearRuntimeComposerState();
  });

  it("isolates mode and draft by terminal without persisting draft text", () => {
    writeDesktopInputModePreference("direct");
    writeRuntimeInputMode("terminal-a", "composer");
    writeRuntimeComposerDraft(
      "terminal-a",
      updateComposerDraftText(createComposerDraftState(), "A"),
    );
    writeRuntimeComposerDraft(
      "terminal-b",
      updateComposerDraftText(createComposerDraftState(), "B"),
    );

    expect(readRuntimeInputMode("terminal-a")).toBe("composer");
    expect(readRuntimeInputMode("terminal-b")).toBe("direct");
    expect(readRuntimeComposerDraft("terminal-a").text).toBe("A");
    expect(readRuntimeComposerDraft("terminal-b").text).toBe("B");
    expect(localStorage.getItem("terminal-a")).toBeNull();
  });

  it("drops runtime state on reload-equivalent clear", () => {
    writeRuntimeInputMode("terminal-a", "composer");
    writeRuntimeComposerDraft(
      "terminal-a",
      updateComposerDraftText(createComposerDraftState(), "secret"),
    );

    clearRuntimeComposerState();

    expect(readRuntimeInputMode("terminal-a")).toBe("direct");
    expect(readRuntimeComposerDraft("terminal-a")).toEqual({
      text: "",
      revision: 0,
      inFlight: null,
    });
  });

  it("notifies only subscribers for the terminal whose runtime draft changed", () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const unsubscribeA = subscribeRuntimeComposerDraft("terminal-a", (draft) =>
      receivedA.push(draft.text),
    );
    const unsubscribeB = subscribeRuntimeComposerDraft("terminal-b", (draft) =>
      receivedB.push(draft.text),
    );

    writeRuntimeComposerDraft(
      "terminal-a",
      updateComposerDraftText(createComposerDraftState(), "A"),
    );
    expect(receivedA).toEqual(["A"]);
    expect(receivedB).toEqual([]);

    unsubscribeA();
    unsubscribeB();
  });
});

describe("composer draft state", () => {
  it("increments revision only when text actually changes", () => {
    const initial = createComposerDraftState();
    const changed = updateComposerDraftText(initial, "hello");

    expect(changed).toMatchObject({ text: "hello", revision: 1, inFlight: null });
    expect(updateComposerDraftText(changed, "hello")).toBe(changed);
    expect(updateComposerDraftText(changed, "hello!").revision).toBe(2);
  });

  it("captures an atomic submission snapshot and blocks a duplicate begin", () => {
    const draft = updateComposerDraftText(createComposerDraftState(), "한글\ntext");
    const started = beginComposerSubmission(draft, {
      terminalId: "terminal-a",
      token: "token-a",
    });

    expect(started).not.toBeNull();
    expect(started?.submission).toEqual({
      terminalId: "terminal-a",
      revision: 1,
      text: "한글\ntext",
      token: "token-a",
    });
    expect(started?.draft.inFlight).toEqual(started?.submission);
    expect(
      beginComposerSubmission(started!.draft, {
        terminalId: "terminal-a",
        token: "token-b",
      }),
    ).toBeNull();
  });

  it("clears only after success for the unchanged submitted snapshot", () => {
    const draft = updateComposerDraftText(createComposerDraftState(), "send me");
    const started = beginComposerSubmission(draft, {
      terminalId: "terminal-a",
      token: "token-a",
    })!;

    expect(
      settleComposerSubmission(started.draft, { token: "token-a", outcome: "success" }),
    ).toEqual({ text: "", revision: 2, inFlight: null });
  });

  it("preserves edits made while the request is in flight", () => {
    const draft = updateComposerDraftText(createComposerDraftState(), "first");
    const started = beginComposerSubmission(draft, {
      terminalId: "terminal-a",
      token: "token-a",
    })!;
    const edited = updateComposerDraftText(started.draft, "first + next");

    expect(settleComposerSubmission(edited, { token: "token-a", outcome: "success" })).toEqual({
      text: "first + next",
      revision: 2,
      inFlight: null,
    });
  });

  it.each(["failure", "cancelled", "ambiguous"] as const)(
    "preserves the draft after a %s outcome",
    (outcome) => {
      const draft = updateComposerDraftText(createComposerDraftState(), "keep me");
      const started = beginComposerSubmission(draft, {
        terminalId: "terminal-a",
        token: "token-a",
      })!;

      expect(settleComposerSubmission(started.draft, { token: "token-a", outcome })).toEqual({
        text: "keep me",
        revision: 1,
        inFlight: null,
      });
    },
  );

  it("ignores a stale completion token without disturbing the active request", () => {
    const draft = updateComposerDraftText(createComposerDraftState(), "keep me");
    const started = beginComposerSubmission(draft, {
      terminalId: "terminal-b",
      token: "current-token",
    })!;

    expect(
      settleComposerSubmission(started.draft, {
        token: "stale-token",
        outcome: "success",
      }),
    ).toBe(started.draft);
  });

  it("supports an empty Send snapshot without inventing a text revision", () => {
    const started = beginComposerSubmission(createComposerDraftState(), {
      terminalId: "terminal-a",
      token: "empty-send",
    })!;

    expect(started.submission.text).toBe("");
    expect(
      settleComposerSubmission(started.draft, { token: "empty-send", outcome: "success" }),
    ).toEqual({ text: "", revision: 0, inFlight: null });
  });
});

/**
 * Regression guard for the security invariant of the desktop composer recall
 * features (#504 Tab popup, #505 autocomplete, and edge ↑/↓ recall): the actual
 * *input content* — draft text, sent-history entries, autocomplete candidates —
 * is strictly in-memory (runtime Maps) and must never reach any persistent or
 * exported store. Passwords, tokens, and other secrets typed into the composer
 * cannot leak to disk. Only the boolean feature toggles (settings.json) and the
 * UI-only mode/height prefs (localStorage) persist — and those carry no content.
 *
 * Mirrors the same in-memory-only principle applied to the Remote composer.
 */
describe("입력 내용 in-memory only 보장 (보안: 비밀번호 등 누출 방지)", () => {
  // Secret-looking strings that must never surface in a persistent store.
  const SECRETS = [
    "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
    "mysql -u root -pSup3rS3cr3tP@ssw0rd",
    "curl -H 'Authorization: Bearer sk-live-0xDEADBEEFCAFE'",
    "echo 비밀번호는-절대-저장되면-안된다",
  ];
  const TERMINAL_ID = "terminal-secret";

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearRuntimeComposerState();
  });

  afterEach(() => {
    clearRuntimeComposerState();
    localStorage.clear();
    sessionStorage.clear();
  });

  /** Full JSON dump of a web Storage so we can assert content never appears in it. */
  function serializeStorage(storage: Storage): string {
    const dump: Record<string, string | null> = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) dump[key] = storage.getItem(key);
    }
    return JSON.stringify(dump);
  }

  it("keeps sent-history recallable in memory yet absent from local/session storage", () => {
    for (const secret of SECRETS) pushComposerHistory(TERMINAL_ID, secret);

    // Recall works from the runtime Map...
    expect(readComposerHistory(TERMINAL_ID)).toEqual(SECRETS);

    // ...but nothing landed in either web storage.
    const localDump = serializeStorage(localStorage);
    const sessionDump = serializeStorage(sessionStorage);
    for (const secret of SECRETS) {
      expect(localDump).not.toContain(secret);
      expect(sessionDump).not.toContain(secret);
    }

    // A WebView reload (runtime clear) erases the history entirely.
    clearRuntimeComposerState();
    expect(readComposerHistory(TERMINAL_ID)).toEqual([]);
  });

  it("never passes draft or history content to Storage.setItem", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    // Drive the realistic runtime flow: type a draft, then record it as sent
    // history — exactly what TerminalView does on a successful Send.
    for (const secret of SECRETS) {
      writeRuntimeComposerDraft(
        TERMINAL_ID,
        updateComposerDraftText(createComposerDraftState(), secret),
      );
      pushComposerHistory(TERMINAL_ID, secret);
    }
    // Legitimate UI-only persistence (mode + height) may write to storage, but
    // the persisted *values* must never be the input content.
    writeDesktopInputModePreference("composer");
    writeComposerHeight(180);

    for (const [, value] of setItemSpy.mock.calls) {
      for (const secret of SECRETS) expect(String(value ?? "")).not.toContain(secret);
    }
    setItemSpy.mockRestore();
  });

  it("persists only UI-only prefs, keying nothing to the terminal or its content", () => {
    writeComposerHeight(180);
    writeDesktopInputModePreference("composer");
    writeRuntimeComposerDraft(
      TERMINAL_ID,
      updateComposerDraftText(createComposerDraftState(), SECRETS[0]),
    );
    pushComposerHistory(TERMINAL_ID, SECRETS[0]);

    const localDump = serializeStorage(localStorage);
    // The two UI-only preference keys are the *only* things persisted.
    expect(localDump).toContain(DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY);
    expect(localDump).toContain(DESKTOP_INPUT_MODE_STORAGE_KEY);
    expect(localDump).not.toContain(SECRETS[0]);
    // No per-terminal key exists — the composer never keys storage by terminal id.
    expect(localStorage.getItem(TERMINAL_ID)).toBeNull();
  });

  it("recall selectors are pure — they derive views without any storage side-effect", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    const popup = selectComposerHistoryEntries(SECRETS);
    const suggestions = selectComposerAutocompleteSuggestions(SECRETS, "export");

    // They return derived, in-memory views of the input...
    expect(popup).toContain(SECRETS[0]);
    expect(suggestions).toContain(SECRETS[0]);
    // ...without persisting anything.
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(serializeStorage(localStorage)).not.toContain(SECRETS[0]);
    setItemSpy.mockRestore();
  });

  it("keeps input content out of the persisted settings-store snapshot", () => {
    // The feature toggles live in settings.json (persistent); their values are
    // booleans. Flipping them and capturing history must not co-mingle content
    // into the settings snapshot — the two subsystems stay decoupled.
    useSettingsStore.getState().setTerminal({
      composerHistoryPopup: false,
      composerAutocomplete: true,
    });
    for (const secret of SECRETS) pushComposerHistory(TERMINAL_ID, secret);

    // JSON.stringify drops the action functions, leaving exactly what serializes
    // to settings.json.
    const snapshot = JSON.stringify(useSettingsStore.getState());
    for (const secret of SECRETS) expect(snapshot).not.toContain(secret);

    // The toggles themselves persist as plain booleans (feature on/off, not content).
    expect(typeof useSettingsStore.getState().terminal.composerHistoryPopup).toBe("boolean");
    expect(typeof useSettingsStore.getState().terminal.composerAutocomplete).toBe("boolean");
  });
});
