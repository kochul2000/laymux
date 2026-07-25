/**
 * Event-sequence fixtures for the Linux IME candidate-key guard (issue #528).
 *
 * These are the traces the guard is specified against. They are reconstructed
 * from the reported Sogou/fcitx behaviour in the upstream reports
 * (stablyai/orca#7543, fixed in stablyai/orca#7634): the key that selects a
 * candidate is re-emitted as ordinary key events around `compositionend`, either
 * as a full `keydown → keypress → keyup` carrying the IME-processed marker
 * (`keyCode === 229`), or as an orphan `keyup` with no `keydown` at all.
 *
 * They are **not** captured from a Linux machine — see the PR description. Each
 * trace therefore records what it asserts about the platform so a later real
 * capture can be diffed against it rather than silently replacing it.
 */

export type TraceStep =
  | { at: number; kind: "compositionstart" }
  | { at: number; kind: "compositionupdate"; data: string }
  | { at: number; kind: "compositionend" }
  | { at: number; kind: "textinput"; isComposing: boolean }
  | {
      at: number;
      kind: "keydown" | "keypress" | "keyup";
      code: string;
      key: string;
      keyCode?: number;
      repeat?: boolean;
    };

export type CandidateTrace = {
  name: string;
  /** What this trace claims the platform does. */
  platformClaim: string;
  steps: TraceStep[];
  /**
   * Indices into `steps` whose key events must be blocked. Everything else must
   * pass through.
   */
  expectBlockedStepIndexes: number[];
};

/**
 * Sogou: candidate picked with Space. The IME emits the full trio *after*
 * `compositionend`, all three carrying `keyCode === 229`.
 */
export const SOGOU_SPACE_FULL_TRIO: CandidateTrace = {
  name: "sogou: Space candidate, full trio after compositionend, keyCode 229",
  platformClaim:
    "compositionend precedes the trio, and every event of the consumed press reports keyCode 229",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 5, kind: "compositionupdate", data: "ni" },
    { at: 40, kind: "compositionend" },
    { at: 41, kind: "keydown", code: "Space", key: " ", keyCode: 229 },
    { at: 42, kind: "keypress", code: "Space", key: " ", keyCode: 229 },
    { at: 43, kind: "keyup", code: "Space", key: " ", keyCode: 229 },
  ],
  expectBlockedStepIndexes: [3, 4, 5],
};

/**
 * fcitx: candidate picked with a digit; only the tail of the press survives the
 * composition, so the `keyup` arrives with no `keydown` before it.
 */
export const FCITX_DIGIT_ORPHAN_KEYUP: CandidateTrace = {
  name: "fcitx: digit candidate, orphan keyup with no keydown",
  platformClaim: "the keydown is swallowed by the IME; only a keyup escapes, without keyCode 229",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 4, kind: "compositionupdate", data: "zhong" },
    { at: 30, kind: "compositionend" },
    { at: 31, kind: "keyup", code: "Digit2", key: "2" },
  ],
  expectBlockedStepIndexes: [3],
};

/**
 * The regression the naive "drop the first printable key after composition"
 * rule causes: the user confirms, then genuinely types a Space. Nothing here may
 * be blocked.
 */
export const REAL_SPACE_AFTER_CONFIRM: CandidateTrace = {
  name: "user types a real Space right after confirming a candidate",
  platformClaim: "a user press reports its own keyCode (32) and starts with a keydown",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 6, kind: "compositionupdate", data: "han" },
    { at: 25, kind: "compositionend" },
    { at: 26, kind: "keydown", code: "Space", key: " ", keyCode: 32 },
    { at: 27, kind: "keypress", code: "Space", key: " ", keyCode: 32 },
    { at: 28, kind: "textinput", isComposing: false },
    { at: 40, kind: "keyup", code: "Space", key: " ", keyCode: 32 },
  ],
  expectBlockedStepIndexes: [],
};

/** Same, for a digit — the other key class an IME uses for candidates. */
export const REAL_DIGIT_AFTER_CONFIRM: CandidateTrace = {
  name: "user types a real digit right after confirming a candidate",
  platformClaim: "a user digit press reports keyCode 49 and starts with a keydown",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 6, kind: "compositionupdate", data: "yi" },
    { at: 25, kind: "compositionend" },
    { at: 26, kind: "keydown", code: "Digit1", key: "1", keyCode: 49 },
    { at: 27, kind: "keypress", code: "Digit1", key: "1", keyCode: 49 },
    { at: 28, kind: "textinput", isComposing: false },
    { at: 33, kind: "keyup", code: "Digit1", key: "1", keyCode: 49 },
  ],
  expectBlockedStepIndexes: [],
};

/**
 * An empty `compositionupdate` mid-composition. Mistaking it for the end would
 * open the window early, and the still-composing candidate press would then be
 * judged against a stale window.
 */
export const EMPTY_UPDATE_MID_COMPOSITION: CandidateTrace = {
  name: "empty compositionupdate does not end the composition",
  platformClaim: "fcitx clears the preedit with an empty compositionupdate and keeps composing",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 5, kind: "compositionupdate", data: "ni" },
    { at: 10, kind: "compositionupdate", data: "" },
    // Still composing: xterm's own guard owns this key, so we must not block it.
    { at: 11, kind: "keydown", code: "Space", key: " ", keyCode: 229 },
    { at: 20, kind: "compositionupdate", data: "你" },
    { at: 30, kind: "compositionend" },
  ],
  expectBlockedStepIndexes: [],
};

/** Windows Korean input: no candidate window may ever open (guard disabled). */
export const WINDOWS_KOREAN_BASELINE: CandidateTrace = {
  name: "windows korean input is untouched",
  platformClaim: "the guard is disabled off Linux, so the sequence is byte-for-byte unchanged",
  steps: [
    { at: 0, kind: "compositionstart" },
    { at: 5, kind: "compositionupdate", data: "ㄱ" },
    { at: 12, kind: "compositionupdate", data: "가" },
    { at: 20, kind: "compositionend" },
    { at: 21, kind: "keydown", code: "Space", key: " ", keyCode: 229 },
    { at: 22, kind: "keypress", code: "Space", key: " ", keyCode: 229 },
    { at: 23, kind: "keyup", code: "Space", key: " ", keyCode: 229 },
  ],
  expectBlockedStepIndexes: [],
};

export const CANDIDATE_TRACES: CandidateTrace[] = [
  SOGOU_SPACE_FULL_TRIO,
  FCITX_DIGIT_ORPHAN_KEYUP,
  REAL_SPACE_AFTER_CONFIRM,
  REAL_DIGIT_AFTER_CONFIRM,
  EMPTY_UPDATE_MID_COMPOSITION,
];
