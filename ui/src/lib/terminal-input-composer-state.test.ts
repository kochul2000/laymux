import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";
import {
  isComposerKeyProxyActive,
  resolveComposerCompositionCommit,
  DEFAULT_COMPOSER_HEIGHT,
  DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY,
  DESKTOP_INPUT_MODE_STORAGE_KEY,
  MAX_COMPOSER_HEIGHT,
  MIN_COMPOSER_HEIGHT,
  beginComposerSubmission,
  clampComposerHeight,
  DEFAULT_COMPOSER_HISTORY_POPUP_ITEMS,
  DEFAULT_COMPOSER_AUTOCOMPLETE_ITEMS,
  clearComposerHistoryForWorkspace,
  clearRuntimeComposerState,
  composerHistoryScopeKey,
  COMPOSER_HISTORY_SCOPES,
  createComposerDraftState,
  DEFAULT_COMPOSER_HISTORY_SCOPE,
  isComposerHistoryScope,
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
  subscribeRuntimeInputMode,
  updateComposerDraftText,
  writeComposerHeight,
  writeDesktopInputModePreference,
  writeRuntimeComposerDraft,
  writeRuntimeInputMode,
  type InputMode,
} from "./terminal-input-composer-state";

/** Bucket key shorthands — the only sanctioned way to address a history bucket. */
const paneBucket = (terminalId: string) => composerHistoryScopeKey("pane", { terminalId });
const workspaceBucket = (terminalId: string, workspaceId?: string | null) =>
  composerHistoryScopeKey("workspace", { terminalId, workspaceId });
const globalBucket = (terminalId: string) => composerHistoryScopeKey("global", { terminalId });

describe("composer sent-history", () => {
  beforeEach(() => {
    clearRuntimeComposerState();
  });

  it("appends entries, skipping blanks and consecutive duplicates", () => {
    pushComposerHistory(paneBucket("t1"), "one");
    pushComposerHistory(paneBucket("t1"), "one"); // duplicate — ignored
    pushComposerHistory(paneBucket("t1"), ""); // blank — ignored
    pushComposerHistory(paneBucket("t1"), "two");
    expect(readComposerHistory(paneBucket("t1"))).toEqual(["one", "two"]);
  });

  it("isolates pane-scoped history per terminal and clears it with runtime state", () => {
    pushComposerHistory(paneBucket("a"), "cmd-a");
    pushComposerHistory(paneBucket("b"), "cmd-b");
    expect(readComposerHistory(paneBucket("a"))).toEqual(["cmd-a"]);
    clearRuntimeComposerState("a");
    expect(readComposerHistory(paneBucket("a"))).toEqual([]);
    expect(readComposerHistory(paneBucket("b"))).toEqual(["cmd-b"]);
  });
});

describe("composer history scope keys (ADR-0055)", () => {
  beforeEach(() => {
    clearRuntimeComposerState();
  });

  it("defaults to global and accepts exactly the three documented scopes", () => {
    expect(DEFAULT_COMPOSER_HISTORY_SCOPE).toBe("global");
    expect([...COMPOSER_HISTORY_SCOPES]).toEqual(["global", "workspace", "pane"]);
    for (const scope of COMPOSER_HISTORY_SCOPES) expect(isComposerHistoryScope(scope)).toBe(true);
    for (const bad of ["Global", "workspaces", "", null, undefined, 1]) {
      expect(isComposerHistoryScope(bad)).toBe(false);
    }
  });

  it("gives every terminal the same bucket under global scope", () => {
    expect(globalBucket("a")).toBe(globalBucket("b"));
    pushComposerHistory(globalBucket("a"), "shared");
    expect(readComposerHistory(globalBucket("b"))).toEqual(["shared"]);
    // …and keeps the narrower buckets separate.
    expect(readComposerHistory(paneBucket("b"))).toEqual([]);
  });

  it("shares one bucket per workspace under workspace scope", () => {
    expect(workspaceBucket("a", "ws-1")).toBe(workspaceBucket("b", "ws-1"));
    expect(workspaceBucket("a", "ws-1")).not.toBe(workspaceBucket("a", "ws-2"));
    pushComposerHistory(workspaceBucket("a", "ws-1"), "in-ws-1");
    expect(readComposerHistory(workspaceBucket("b", "ws-1"))).toEqual(["in-ws-1"]);
    expect(readComposerHistory(workspaceBucket("c", "ws-2"))).toEqual([]);
  });

  it("falls back to the terminal's own bucket when the workspace is unresolvable", () => {
    // Dock / app-global terminals have no workspace: unknown membership must
    // never widen sharing to the global bucket (fail-narrow).
    for (const missing of [undefined, null, ""]) {
      expect(workspaceBucket("dock-1", missing)).toBe(paneBucket("dock-1"));
    }
    pushComposerHistory(workspaceBucket("dock-1", null), "dock-only");
    expect(readComposerHistory(paneBucket("dock-1"))).toEqual(["dock-only"]);
    expect(readComposerHistory(globalBucket("dock-1"))).toEqual([]);
    expect(readComposerHistory(paneBucket("dock-2"))).toEqual([]);
  });

  it("treats an unknown scope value as pane-local rather than shared", () => {
    const bogus = "everything" as unknown as Parameters<typeof composerHistoryScopeKey>[0];
    expect(composerHistoryScopeKey(bogus, { terminalId: "a", workspaceId: "ws-1" })).toBe(
      paneBucket("a"),
    );
  });

  it("never collides between a workspace id and a terminal id", () => {
    // Same raw id in both roles must still land in different buckets.
    expect(workspaceBucket("x", "same")).not.toBe(paneBucket("same"));
  });

  it("does not merge or migrate entries when the scope changes", () => {
    pushComposerHistory(paneBucket("a"), "pane-entry");
    pushComposerHistory(globalBucket("a"), "global-entry");
    // Switching scope just reads a different bucket; nothing is copied either way.
    expect(readComposerHistory(globalBucket("a"))).toEqual(["global-entry"]);
    expect(readComposerHistory(paneBucket("a"))).toEqual(["pane-entry"]);
  });

  it("keeps shared buckets alive when one pane closes", () => {
    pushComposerHistory(globalBucket("a"), "global-entry");
    pushComposerHistory(workspaceBucket("a", "ws-1"), "ws-entry");
    pushComposerHistory(paneBucket("a"), "pane-entry");

    clearRuntimeComposerState("a");

    // Only the closing pane's own bucket goes away — other panes still recall.
    expect(readComposerHistory(paneBucket("a"))).toEqual([]);
    expect(readComposerHistory(globalBucket("a"))).toEqual(["global-entry"]);
    expect(readComposerHistory(workspaceBucket("b", "ws-1"))).toEqual(["ws-entry"]);
  });

  it("drops a deleted workspace's bucket and nothing else", () => {
    pushComposerHistory(workspaceBucket("a", "ws-1"), "ws-1-entry");
    pushComposerHistory(workspaceBucket("b", "ws-2"), "ws-2-entry");
    pushComposerHistory(globalBucket("a"), "global-entry");

    clearComposerHistoryForWorkspace("ws-1");

    expect(readComposerHistory(workspaceBucket("a", "ws-1"))).toEqual([]);
    expect(readComposerHistory(workspaceBucket("b", "ws-2"))).toEqual(["ws-2-entry"]);
    expect(readComposerHistory(globalBucket("a"))).toEqual(["global-entry"]);
  });

  it("clears every bucket on a full runtime reset (WebView reload)", () => {
    pushComposerHistory(globalBucket("a"), "global-entry");
    pushComposerHistory(workspaceBucket("a", "ws-1"), "ws-entry");
    pushComposerHistory(paneBucket("a"), "pane-entry");

    clearRuntimeComposerState();

    expect(readComposerHistory(globalBucket("a"))).toEqual([]);
    expect(readComposerHistory(workspaceBucket("a", "ws-1"))).toEqual([]);
    expect(readComposerHistory(paneBucket("a"))).toEqual([]);
  });

  it("caps each bucket at 200 entries independently of scope", () => {
    for (let i = 0; i < 250; i += 1) pushComposerHistory(globalBucket("a"), `cmd-${i}`);
    const entries = readComposerHistory(globalBucket("a"));
    expect(entries).toHaveLength(200);
    expect(entries[0]).toBe("cmd-50");
    expect(entries[entries.length - 1]).toBe("cmd-249");
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

  // `useSyncExternalStore` re-reads the snapshot on every render and throws
  // "getSnapshot should be cached" if the identity keeps changing. An unseeded
  // terminal must therefore hand back the same empty draft object every time.
  it("returns a stable empty-draft identity for a terminal that has never been written", () => {
    expect(readRuntimeComposerDraft("terminal-fresh")).toBe(
      readRuntimeComposerDraft("terminal-fresh"),
    );
    expect(readRuntimeComposerDraft("terminal-fresh")).toBe(readRuntimeComposerDraft("other"));
    expect(readRuntimeComposerDraft("terminal-fresh")).toEqual({
      text: "",
      revision: 0,
      inFlight: null,
    });
  });

  it("notifies input-mode subscribers only for the terminal whose mode changed", () => {
    const receivedA: InputMode[] = [];
    const receivedB: InputMode[] = [];
    const unsubscribeA = subscribeRuntimeInputMode("terminal-a", () =>
      receivedA.push(readRuntimeInputMode("terminal-a")),
    );
    const unsubscribeB = subscribeRuntimeInputMode("terminal-b", () =>
      receivedB.push(readRuntimeInputMode("terminal-b")),
    );

    writeRuntimeInputMode("terminal-a", "composer");
    expect(receivedA).toEqual(["composer"]);
    expect(receivedB).toEqual([]);

    unsubscribeA();
    writeRuntimeInputMode("terminal-a", "direct");
    expect(receivedA).toEqual(["composer"]);

    unsubscribeB();
  });

  // The desktop preference only seeds a terminal that has no mode of its own.
  // Once seeded, a later preference change must not silently retro-flip that
  // terminal — the snapshot has to stay stable for `useSyncExternalStore`.
  it("pins the desktop default per terminal on first read", () => {
    writeDesktopInputModePreference("direct");
    expect(readRuntimeInputMode("terminal-a")).toBe("direct");

    writeDesktopInputModePreference("composer");
    expect(readRuntimeInputMode("terminal-a")).toBe("direct");
    // A terminal read for the first time still picks up the current default.
    expect(readRuntimeInputMode("terminal-b")).toBe("composer");
  });

  it("re-seeds the pinned default after runtime state is cleared", () => {
    writeDesktopInputModePreference("direct");
    expect(readRuntimeInputMode("terminal-a")).toBe("direct");

    writeDesktopInputModePreference("composer");
    clearRuntimeComposerState("terminal-a");
    expect(readRuntimeInputMode("terminal-a")).toBe("composer");

    writeDesktopInputModePreference("direct");
    clearRuntimeComposerState();
    expect(readRuntimeInputMode("terminal-a")).toBe("direct");
  });

  it("notifies input-mode subscribers when runtime state is cleared", () => {
    writeRuntimeInputMode("terminal-a", "composer");
    let notifications = 0;
    const unsubscribe = subscribeRuntimeInputMode("terminal-a", () => {
      notifications += 1;
    });

    clearRuntimeComposerState("terminal-a");
    expect(notifications).toBe(1);
    expect(readRuntimeInputMode("terminal-a")).toBe("direct");

    writeRuntimeInputMode("terminal-a", "composer");
    clearRuntimeComposerState();
    expect(notifications).toBe(3);

    unsubscribe();
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
    for (const secret of SECRETS) pushComposerHistory(paneBucket(TERMINAL_ID), secret);

    // Recall works from the runtime Map...
    expect(readComposerHistory(paneBucket(TERMINAL_ID))).toEqual(SECRETS);

    // ...but nothing landed in either web storage.
    const localDump = serializeStorage(localStorage);
    const sessionDump = serializeStorage(sessionStorage);
    for (const secret of SECRETS) {
      expect(localDump).not.toContain(secret);
      expect(sessionDump).not.toContain(secret);
    }

    // A WebView reload (runtime clear) erases the history entirely.
    clearRuntimeComposerState();
    expect(readComposerHistory(paneBucket(TERMINAL_ID))).toEqual([]);
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
      pushComposerHistory(paneBucket(TERMINAL_ID), secret);
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
    pushComposerHistory(paneBucket(TERMINAL_ID), SECRETS[0]);

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
      // The scope is a choice, not content — widening it must not pull any
      // recalled text into the persisted snapshot either (ADR-0055).
      composerHistoryScope: "global",
    });
    for (const secret of SECRETS) pushComposerHistory(globalBucket(TERMINAL_ID), secret);
    for (const secret of SECRETS) pushComposerHistory(paneBucket(TERMINAL_ID), secret);

    // JSON.stringify drops the action functions, leaving exactly what serializes
    // to settings.json.
    const snapshot = JSON.stringify(useSettingsStore.getState());
    for (const secret of SECRETS) expect(snapshot).not.toContain(secret);

    // The toggles themselves persist as plain booleans (feature on/off, not content).
    expect(typeof useSettingsStore.getState().terminal.composerHistoryPopup).toBe("boolean");
    expect(typeof useSettingsStore.getState().terminal.composerAutocomplete).toBe("boolean");
    // The scope persists as one of the three enum strings, never as history text.
    expect(COMPOSER_HISTORY_SCOPES).toContain(
      useSettingsStore.getState().terminal.composerHistoryScope,
    );
  });
});

describe("isComposerKeyProxyActive", () => {
  // Issues #558/#560. One rule decides every routing question on this surface: an
  // empty draft lends the keyboard out, a non-empty draft keeps it. The non-empty
  // half is what gives text on screen a way out — Enter submits it, Backspace erases
  // it — instead of stranding it while every key goes to the app.
  it("lends the keyboard to a fullscreen app only while the draft is empty", () => {
    expect(isComposerKeyProxyActive({ altScreen: true, draftEmpty: true })).toBe(true);
    expect(isComposerKeyProxyActive({ altScreen: true, draftEmpty: false })).toBe(false);
  });

  it("never lends it on the normal buffer, where the draft is the drafting surface", () => {
    // The shell case forwards a narrow key set (nav keys, Ctrl+C/D/Z/L) through its
    // own check; whole-keyboard proxying is a fullscreen-app property.
    expect(isComposerKeyProxyActive({ altScreen: false, draftEmpty: true })).toBe(false);
    expect(isComposerKeyProxyActive({ altScreen: false, draftEmpty: false })).toBe(false);
  });
});

describe("resolveComposerCompositionCommit", () => {
  // Issue #558. In the alternate screen the composer forwards every key to the PTY,
  // which is why ASCII lands in a fullscreen app as it is typed. A composition cannot
  // be forwarded key by key, so its text piled up in the draft and then no key could
  // reach the draft any more — Enter and Backspace both went to the app. The draft
  // became unreachable: not submittable, not erasable.
  it("routes an alternate-screen commit to the PTY when it is the whole draft", () => {
    expect(resolveComposerCompositionCommit({ altScreen: true, data: "가", draft: "가" })).toEqual({
      pty: "가",
    });
  });

  it("routes a multi-syllable commit the same way", () => {
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "가나다", draft: "가나다" }),
    ).toEqual({ pty: "가나다" });
  });

  it("leaves the normal buffer alone — there the draft is a real drafting surface", () => {
    // Enter submits the draft in the normal composer flow, so nothing may be diverted.
    expect(
      resolveComposerCompositionCommit({ altScreen: false, data: "가", draft: "가" }),
    ).toBeNull();
  });

  it("writes nothing when the IME cancelled instead of committing", () => {
    // Same rule as the terminal-side blur commit: `compositionend` with empty data is
    // a cancel, and we never invent text the IME did not hand us.
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "", draft: "가나" }),
    ).toBeNull();
  });

  it("keeps a syllable in a draft that already held text (issue #560)", () => {
    // A non-empty draft owns the keyboard, so Enter will submit this whole line.
    // Diverting the last syllable would tear one sentence across two destinations.
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "다", draft: "가나다" }),
    ).toBeNull();
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "가", draft: "line\n가" }),
    ).toBeNull();
  });

  it("keeps a draft whose tail does not match the commit", () => {
    // Not describable in terms of this commit, so it is the user's text, not ours.
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "다", draft: "가나 " }),
    ).toBeNull();
  });

  it("routes a commit whose draft lags one keystroke behind", () => {
    // Some IMEs deliver the final `input` event after `compositionend`, so the draft
    // is a prefix of the commit. That is event ordering, not user text — treating it
    // as a non-empty prior draft would strand the syllable in the draft instead.
    expect(
      resolveComposerCompositionCommit({ altScreen: true, data: "가나다", draft: "가나" }),
    ).toEqual({ pty: "가나다" });
    expect(resolveComposerCompositionCommit({ altScreen: true, data: "가", draft: "" })).toEqual({
      pty: "가",
    });
  });
});
