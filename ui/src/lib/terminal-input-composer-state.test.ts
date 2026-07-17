import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSER_HEIGHT,
  DESKTOP_COMPOSER_HEIGHT_STORAGE_KEY,
  DESKTOP_INPUT_MODE_STORAGE_KEY,
  MAX_COMPOSER_HEIGHT,
  MIN_COMPOSER_HEIGHT,
  beginComposerSubmission,
  clampComposerHeight,
  clearRuntimeComposerState,
  createComposerDraftState,
  readComposerHeight,
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
