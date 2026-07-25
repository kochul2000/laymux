import { beforeEach, describe, expect, it } from "vitest";

import {
  createOsInputSourceChordGuard,
  type OsInputSourceChordKeyEvent,
} from "./os-input-source-chord";

/** Shift+Space, the chord a Korean user typically binds for input-source switching. */
function shiftSpace(type: OsInputSourceChordKeyEvent["type"]): OsInputSourceChordKeyEvent {
  return { type, code: "Space", key: " ", shiftKey: true, ctrlKey: false, altKey: false };
}

function plainSpace(type: OsInputSourceChordKeyEvent["type"]): OsInputSourceChordKeyEvent {
  return { type, code: "Space", key: " ", shiftKey: false, ctrlKey: false, altKey: false };
}

function letterA(type: OsInputSourceChordKeyEvent["type"]): OsInputSourceChordKeyEvent {
  return { type, code: "KeyA", key: "a", shiftKey: false, ctrlKey: false, altKey: false };
}

/** Guard bound to Shift+Space. */
function boundGuard() {
  return createOsInputSourceChordGuard({
    matchesChord: (event) => event.shiftKey && event.code === "Space",
  });
}

describe("createOsInputSourceChordGuard", () => {
  describe("when no chord is bound", () => {
    // The action ships unassigned, so every terminal key must behave exactly as
    // before — this is the regression gate for "기존 terminal 입력이 완전히 유지된다".
    const guard = createOsInputSourceChordGuard({ matchesChord: () => false });

    it("blocks nothing across the whole event sequence", () => {
      expect(guard.shouldBlockKey(shiftSpace("keydown"))).toBe(false);
      expect(guard.shouldBlockKey(shiftSpace("keypress"))).toBe(false);
      expect(guard.shouldBlockKey(shiftSpace("keyup"))).toBe(false);
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(false);
      expect(guard.isArmed()).toBe(false);
    });
  });

  describe("when the chord is bound", () => {
    let guard: ReturnType<typeof boundGuard>;

    beforeEach(() => {
      guard = boundGuard();
    });

    it("blocks the full event sequence derived from the chord press", () => {
      expect(guard.shouldBlockKey(shiftSpace("keydown"))).toBe(true);
      expect(guard.isArmed()).toBe(true);
      // The companion keypress is what leaks a literal Space into the PTY.
      expect(guard.shouldBlockKey(shiftSpace("keypress"))).toBe(true);
      // The textarea insertion that would otherwise reach xterm's `input` path.
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(true);
      expect(guard.shouldBlockKey(shiftSpace("keyup"))).toBe(true);
      // keyup ends the physical press, so nothing stays armed.
      expect(guard.isArmed()).toBe(false);
    });

    it("blocks a keypress whose modifier state already dropped", () => {
      // Releasing Shift before Space can produce a companion keypress without
      // shiftKey, which would no longer match the chord on its own.
      guard.shouldBlockKey(shiftSpace("keydown"));
      expect(guard.shouldBlockKey(plainSpace("keypress"))).toBe(true);
      expect(guard.shouldBlockKey(plainSpace("keyup"))).toBe(true);
      expect(guard.isArmed()).toBe(false);
    });

    it("keeps blocking across auto-repeat and releases once", () => {
      guard.shouldBlockKey(shiftSpace("keydown"));
      expect(guard.shouldBlockKey({ ...shiftSpace("keydown"), repeat: true })).toBe(true);
      expect(guard.shouldBlockKey({ ...shiftSpace("keypress"), repeat: true })).toBe(true);
      expect(guard.isArmed()).toBe(true);
      expect(guard.shouldBlockKey(shiftSpace("keyup"))).toBe(true);
      expect(guard.isArmed()).toBe(false);
      // A later ordinary Space is untouched.
      expect(guard.shouldBlockKey(plainSpace("keydown"))).toBe(false);
    });

    it("does not block a plain Space that never matched the chord", () => {
      expect(guard.shouldBlockKey(plainSpace("keydown"))).toBe(false);
      expect(guard.shouldBlockKey(plainSpace("keypress"))).toBe(false);
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(false);
      expect(guard.shouldBlockKey(plainSpace("keyup"))).toBe(false);
    });

    it("does not block a normal Space typed right after the chord", () => {
      guard.shouldBlockKey(shiftSpace("keydown"));
      guard.shouldBlockKey(shiftSpace("keyup"));
      expect(guard.shouldBlockKey(plainSpace("keydown"))).toBe(false);
      expect(guard.shouldBlockKey(plainSpace("keypress"))).toBe(false);
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(false);
    });

    it("releases on a different physical key instead of swallowing it", () => {
      guard.shouldBlockKey(shiftSpace("keydown"));
      // A different key means the chord press is over as far as we can tell; its
      // own events must reach the terminal.
      expect(guard.shouldBlockKey(letterA("keydown"))).toBe(false);
      expect(guard.isArmed()).toBe(false);
      expect(guard.shouldBlockKey(letterA("keypress"))).toBe(false);
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(false);
    });

    it("ignores an orphan keyup for a key that was never armed", () => {
      expect(guard.shouldBlockKey(plainSpace("keyup"))).toBe(false);
      expect(guard.shouldBlockKey(letterA("keyup"))).toBe(false);
    });

    it("never blocks composition text input while armed", () => {
      // An IME composition must keep working even if the chord is held: the
      // composing insertion belongs to the IME, not to the chord.
      guard.shouldBlockKey(shiftSpace("keydown"));
      expect(guard.shouldBlockTextInput({ isComposing: true })).toBe(false);
      // ...and the non-composing insertion from the same press is still blocked.
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(true);
    });

    it("releases on reset (blur, unmount, pane handoff)", () => {
      guard.shouldBlockKey(shiftSpace("keydown"));
      expect(guard.isArmed()).toBe(true);
      guard.reset("blur");
      expect(guard.isArmed()).toBe(false);
      // Nothing from the abandoned press may keep swallowing input.
      expect(guard.shouldBlockKey(shiftSpace("keypress"))).toBe(false);
      expect(guard.shouldBlockTextInput({ isComposing: false })).toBe(false);
    });

    it("re-arms on a fresh chord press after a reset", () => {
      guard.shouldBlockKey(shiftSpace("keydown"));
      guard.reset("blur");
      expect(guard.shouldBlockKey(shiftSpace("keydown"))).toBe(true);
      expect(guard.shouldBlockKey(shiftSpace("keyup"))).toBe(true);
    });

    it("matches a chord on a key with no code (synthetic events) by key token", () => {
      const codeless = createOsInputSourceChordGuard({
        matchesChord: (event) => event.shiftKey && event.key === " ",
      });
      const noCode: OsInputSourceChordKeyEvent = {
        type: "keydown",
        code: "",
        key: " ",
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
      };
      expect(codeless.shouldBlockKey(noCode)).toBe(true);
      expect(codeless.shouldBlockKey({ ...noCode, type: "keypress" })).toBe(true);
      expect(codeless.shouldBlockKey({ ...noCode, type: "keyup" })).toBe(true);
      expect(codeless.isArmed()).toBe(false);
    });
  });

  describe("trace", () => {
    it("reports arm and release with a reason", () => {
      const events: string[] = [];
      const guard = createOsInputSourceChordGuard({
        matchesChord: (event) => event.shiftKey && event.code === "Space",
        onTrace: (event, payload) => events.push(`${event}:${payload.reason ?? ""}`),
      });

      guard.shouldBlockKey(shiftSpace("keydown"));
      guard.shouldBlockKey(shiftSpace("keyup"));
      guard.shouldBlockKey(shiftSpace("keydown"));
      guard.reset("unmount");

      expect(events).toEqual([
        "os-input-source-chord-armed:",
        "os-input-source-chord-released:keyup",
        "os-input-source-chord-armed:",
        "os-input-source-chord-released:unmount",
      ]);
    });
  });
});
