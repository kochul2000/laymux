import { describe, expect, it } from "vitest";

import {
  CANDIDATE_TRACES,
  WINDOWS_KOREAN_BASELINE,
  type CandidateTrace,
  type TraceStep,
} from "./__fixtures__/linux-ime-candidate-traces";
import {
  DEFAULT_CANDIDATE_WINDOW_MS,
  createLinuxImeCandidateGuard,
  isCandidateKey,
  isImeConsumedKey,
  type LinuxImeCandidateGuard,
} from "./linux-ime-candidate-guard";

/** Guard driven by a clock the test advances by hand. */
function buildGuard(overrides: { enabled?: boolean; windowMs?: number } = {}) {
  let clock = 0;
  const traces: string[] = [];
  const guard = createLinuxImeCandidateGuard({
    enabled: overrides.enabled ?? true,
    now: () => clock,
    windowMs: overrides.windowMs,
    onTrace: (event, payload) => traces.push(`${event}:${payload.reason ?? ""}`),
  });
  return {
    guard,
    traces,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

/** Replay a fixture and collect the indexes whose key events were blocked. */
function replay(trace: CandidateTrace, enabled: boolean): number[] {
  let clock = 0;
  const guard = createLinuxImeCandidateGuard({ enabled, now: () => clock });
  const blocked: number[] = [];

  trace.steps.forEach((step: TraceStep, index) => {
    clock = step.at;
    switch (step.kind) {
      case "compositionstart":
        guard.noteCompositionStart();
        break;
      case "compositionupdate":
        guard.noteCompositionUpdate(step.data);
        break;
      case "compositionend":
        guard.noteCompositionEnd();
        break;
      case "textinput":
        guard.noteTextInput({ isComposing: step.isComposing });
        break;
      default: {
        const decision = guard.decideKey({
          type: step.kind,
          code: step.code,
          key: step.key,
          keyCode: step.keyCode,
          repeat: step.repeat,
        });
        if (decision.block) blocked.push(index);
      }
    }
  });

  return blocked;
}

function spaceKey(
  type: "keydown" | "keypress" | "keyup",
  extra: { keyCode?: number; repeat?: boolean } = {},
) {
  return { type, code: "Space", key: " ", keyCode: extra.keyCode ?? 32, repeat: extra.repeat };
}

function imeSpaceKey(type: "keydown" | "keypress" | "keyup", extra: { repeat?: boolean } = {}) {
  return { type, code: "Space", key: " ", keyCode: 229, repeat: extra.repeat };
}

describe("candidate key classification", () => {
  it("treats Space and digits as candidate keys", () => {
    expect(isCandidateKey({ type: "keydown", code: "Space", key: " " })).toBe(true);
    expect(isCandidateKey({ type: "keydown", code: "Digit3", key: "3" })).toBe(true);
    expect(isCandidateKey({ type: "keydown", code: "Numpad7", key: "7" })).toBe(true);
    expect(isCandidateKey({ type: "keydown", code: "KeyA", key: "a" })).toBe(false);
    expect(isCandidateKey({ type: "keydown", code: "Enter", key: "Enter" })).toBe(false);
  });

  it("does not treat a modified combo as a candidate selection", () => {
    expect(isCandidateKey({ type: "keydown", code: "Space", key: " ", ctrlKey: true })).toBe(false);
    expect(isCandidateKey({ type: "keydown", code: "Space", key: " ", altKey: true })).toBe(false);
    expect(isCandidateKey({ type: "keydown", code: "Space", key: " ", metaKey: true })).toBe(false);
  });

  it("falls back to the key token when no code is reported", () => {
    expect(isCandidateKey({ type: "keydown", code: "", key: " " })).toBe(true);
    expect(isCandidateKey({ type: "keydown", code: "", key: "5" })).toBe(true);
    expect(isCandidateKey({ type: "keydown", code: "", key: "a" })).toBe(false);
  });

  it("recognizes the IME-consumed marker", () => {
    expect(isImeConsumedKey({ type: "keydown", code: "Space", key: " ", keyCode: 229 })).toBe(true);
    expect(isImeConsumedKey({ type: "keydown", code: "Space", key: "Process" })).toBe(true);
    expect(isImeConsumedKey({ type: "keydown", code: "Space", key: " ", keyCode: 32 })).toBe(false);
  });
});

describe("recorded candidate traces", () => {
  for (const trace of CANDIDATE_TRACES) {
    it(`matches the expected blocking for — ${trace.name}`, () => {
      expect(replay(trace, true)).toEqual(trace.expectBlockedStepIndexes);
    });
  }

  it("blocks nothing in any trace when the guard is disabled (non-Linux)", () => {
    for (const trace of [...CANDIDATE_TRACES, WINDOWS_KOREAN_BASELINE]) {
      expect(replay(trace, false)).toEqual([]);
    }
  });

  it("leaves Windows Korean input untouched even with the guard enabled off-window", () => {
    // The Windows baseline is the same shape as the Sogou trace, so it is only
    // safe because the guard is disabled off Linux. Assert that explicitly so a
    // future "enable everywhere" change fails loudly here.
    expect(replay(WINDOWS_KOREAN_BASELINE, false)).toEqual([]);
    expect(replay(WINDOWS_KOREAN_BASELINE, true)).not.toEqual([]);
  });
});

describe("createLinuxImeCandidateGuard", () => {
  it("is a no-op when disabled", () => {
    const { guard, advance } = buildGuard({ enabled: false });
    guard.noteCompositionStart();
    guard.noteCompositionEnd();
    advance(1);
    expect(guard.isWindowOpen()).toBe(false);
    expect(guard.decideKey(imeSpaceKey("keypress")).block).toBe(false);
    expect(guard.decideKey(imeSpaceKey("keyup")).block).toBe(false);
  });

  it("opens the window only on compositionend", () => {
    const { guard } = buildGuard();
    expect(guard.isWindowOpen()).toBe(false);
    guard.noteCompositionStart();
    guard.noteCompositionUpdate("ni");
    expect(guard.isWindowOpen()).toBe(false);
    guard.noteCompositionEnd();
    expect(guard.isWindowOpen()).toBe(true);
  });

  it("keeps composing through an empty compositionupdate", () => {
    const { guard } = buildGuard();
    guard.noteCompositionStart();
    guard.noteCompositionUpdate("");
    expect(guard.isWindowOpen()).toBe(false);
    // Still xterm's key while composing.
    expect(guard.decideKey(imeSpaceKey("keydown")).block).toBe(false);
  });

  it("blocks the full IME-consumed trio and asks preventDefault only where it inserts", () => {
    const { guard } = buildGeneratedWindow();
    const down = guard.decideKey(imeSpaceKey("keydown"));
    expect(down).toMatchObject({ block: true, preventDefault: true, reason: "ime-consumed" });
    expect(guard.decideKey(imeSpaceKey("keypress"))).toMatchObject({
      block: true,
      preventDefault: true,
    });
    // keyup cannot insert anything, so its default is left alone.
    expect(guard.decideKey(imeSpaceKey("keyup"))).toMatchObject({
      block: true,
      preventDefault: false,
    });
  });

  it("blocks an orphan keypress and keyup with no preceding keydown", () => {
    const { guard } = buildGeneratedWindow();
    expect(guard.decideKey(spaceKey("keypress"))).toMatchObject({
      block: true,
      preventDefault: true,
      reason: "orphan-companion",
    });

    const { guard: other } = buildGeneratedWindow();
    expect(other.decideKey(spaceKey("keyup"))).toMatchObject({
      block: true,
      preventDefault: false,
      reason: "orphan-companion",
    });
  });

  it("blocks an orphan digit keyup", () => {
    const { guard } = buildGeneratedWindow();
    expect(guard.decideKey({ type: "keyup", code: "Digit2", key: "2", keyCode: 50 }).block).toBe(
      true,
    );
  });

  it("passes a real candidate press and closes the window so its companions pass too", () => {
    const { guard } = buildGeneratedWindow();
    expect(guard.decideKey(spaceKey("keydown")).block).toBe(false);
    expect(guard.isWindowOpen()).toBe(false);
    expect(guard.decideKey(spaceKey("keypress")).block).toBe(false);
    expect(guard.decideKey(spaceKey("keyup")).block).toBe(false);
  });

  it("passes companions of a press that started during the composition", () => {
    const { guard } = buildGuard();
    guard.noteCompositionStart();
    // The user held Space down while composing; xterm owned the keydown.
    expect(guard.decideKey(spaceKey("keydown")).block).toBe(false);
    guard.noteCompositionEnd();
    // Its keyup is not an orphan — we saw the keydown.
    expect(guard.decideKey(spaceKey("keyup")).block).toBe(false);
  });

  it("handles auto-repeat consistently for both classes", () => {
    const { guard } = buildGeneratedWindow();
    // IME-consumed repeats stay blocked.
    expect(guard.decideKey(imeSpaceKey("keydown", { repeat: true })).block).toBe(true);
    expect(guard.decideKey(imeSpaceKey("keypress", { repeat: true })).block).toBe(true);

    const { guard: real } = buildGeneratedWindow();
    // A real repeating press is the user holding the key — never blocked.
    expect(real.decideKey(spaceKey("keydown", { repeat: true })).block).toBe(false);
    expect(real.decideKey(spaceKey("keypress", { repeat: true })).block).toBe(false);
  });

  it("closes the window on a real non-composition text input", () => {
    const { guard } = buildGeneratedWindow();
    guard.noteTextInput({ isComposing: false });
    expect(guard.isWindowOpen()).toBe(false);
    expect(guard.decideKey(spaceKey("keyup")).block).toBe(false);
  });

  it("keeps the window open for a composing text input", () => {
    const { guard } = buildGeneratedWindow();
    guard.noteTextInput({ isComposing: true });
    expect(guard.isWindowOpen()).toBe(true);
  });

  it("closes the window on an unrelated real key", () => {
    const { guard } = buildGeneratedWindow();
    expect(guard.decideKey({ type: "keydown", code: "KeyA", key: "a", keyCode: 65 }).block).toBe(
      false,
    );
    expect(guard.isWindowOpen()).toBe(false);
    // The candidate tail arrives too late now and reaches the terminal.
    expect(guard.decideKey(spaceKey("keyup")).block).toBe(false);
  });

  it("closes the window after the timeout", () => {
    const { guard, advance } = buildGuard({ windowMs: 50 });
    guard.noteCompositionStart();
    guard.noteCompositionEnd();
    expect(guard.isWindowOpen()).toBe(true);
    advance(51);
    expect(guard.isWindowOpen()).toBe(false);
    expect(guard.decideKey(imeSpaceKey("keyup")).block).toBe(false);
  });

  it("uses a window shorter than a human keystroke by default", () => {
    // The bound is a safety net, not the discriminator — it must not be long
    // enough to swallow a key the user pressed deliberately.
    expect(DEFAULT_CANDIDATE_WINDOW_MS).toBeLessThanOrEqual(150);
  });

  it("drops the window on reset (blur, unmount)", () => {
    const { guard } = buildGeneratedWindow();
    guard.reset("blur");
    expect(guard.isWindowOpen()).toBe(false);
    expect(guard.decideKey(imeSpaceKey("keyup")).block).toBe(false);
  });

  it("re-opens a fresh window for the next composition", () => {
    const { guard } = buildGeneratedWindow();
    guard.reset("blur");
    guard.noteCompositionStart();
    guard.noteCompositionEnd();
    expect(guard.decideKey(imeSpaceKey("keyup")).block).toBe(true);
  });

  it("does not carry observed keydowns across compositions", () => {
    const { guard } = buildGuard();
    guard.noteCompositionStart();
    guard.decideKey(spaceKey("keydown"));
    guard.noteCompositionEnd();
    // Second composition: the earlier keydown must not make this keyup look owned.
    guard.noteCompositionStart();
    guard.noteCompositionEnd();
    expect(guard.decideKey(spaceKey("keyup")).block).toBe(true);
  });

  it("traces window transitions with a reason", () => {
    const { guard, traces } = buildGuard();
    guard.noteCompositionStart();
    guard.noteCompositionEnd();
    guard.decideKey(imeSpaceKey("keypress"));
    guard.noteTextInput({ isComposing: false });
    expect(traces).toEqual([
      "linux-ime-candidate-window-opened:",
      "linux-ime-candidate-blocked:ime-consumed",
      "linux-ime-candidate-window-closed:real-text-input",
    ]);
  });
});

/** Guard with the post-composition window already open. */
function buildGeneratedWindow(): { guard: LinuxImeCandidateGuard } {
  const { guard } = buildGuard();
  guard.noteCompositionStart();
  guard.noteCompositionUpdate("ni");
  guard.noteCompositionEnd();
  return { guard };
}
