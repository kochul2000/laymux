import { describe, expect, it } from "vitest";
import {
  encodeTerminalKey,
  isPassthroughControlChord,
  isPassthroughNavKey,
} from "./terminal-key-encoding";

type Key = Parameters<typeof encodeTerminalKey>[0];
const ev = (over: Partial<Key> & Pick<Key, "key">): Key => ({
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("isPassthroughNavKey", () => {
  it("flags non-character navigation keys", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "Escape", "Tab", "Enter"]) {
      expect(isPassthroughNavKey({ key })).toBe(true);
    }
  });

  it("excludes printable characters and modifiers", () => {
    for (const key of ["a", " ", "1", "Shift", "Control"]) {
      expect(isPassthroughNavKey({ key })).toBe(false);
    }
  });
});

describe("encodeTerminalKey", () => {
  it("encodes arrows per DECCKM (application cursor) mode", () => {
    expect(encodeTerminalKey(ev({ key: "ArrowUp" }))).toBe("\x1b[A");
    expect(encodeTerminalKey(ev({ key: "ArrowUp" }), { applicationCursor: true })).toBe("\x1bOA");
    expect(encodeTerminalKey(ev({ key: "ArrowLeft" }))).toBe("\x1b[D");
    expect(encodeTerminalKey(ev({ key: "End" }), { applicationCursor: true })).toBe("\x1bOF");
  });

  it("encodes the common control/navigation keys", () => {
    expect(encodeTerminalKey(ev({ key: "Escape" }))).toBe("\x1b");
    expect(encodeTerminalKey(ev({ key: "Enter" }))).toBe("\r");
    expect(encodeTerminalKey(ev({ key: "Tab" }))).toBe("\t");
    expect(encodeTerminalKey(ev({ key: "Tab", shiftKey: true }))).toBe("\x1b[Z");
    expect(encodeTerminalKey(ev({ key: "Backspace" }))).toBe("\x7f");
    expect(encodeTerminalKey(ev({ key: "PageUp" }))).toBe("\x1b[5~");
    expect(encodeTerminalKey(ev({ key: "Delete" }))).toBe("\x1b[3~");
  });

  it("encodes printable characters and Ctrl/Alt combos for full-screen passthrough", () => {
    expect(encodeTerminalKey(ev({ key: "j" }))).toBe("j");
    expect(encodeTerminalKey(ev({ key: "c", ctrlKey: true }))).toBe("\x03");
    expect(encodeTerminalKey(ev({ key: "a", ctrlKey: true }))).toBe("\x01");
    expect(encodeTerminalKey(ev({ key: "b", altKey: true }))).toBe("\x1bb");
  });

  it("ignores modifier-only keys", () => {
    expect(encodeTerminalKey(ev({ key: "Shift" }))).toBeNull();
    expect(encodeTerminalKey(ev({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(encodeTerminalKey(ev({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("encodes modified navigation keys with the xterm CSI 1;mod form", () => {
    expect(encodeTerminalKey(ev({ key: "ArrowLeft", ctrlKey: true }))).toBe("\x1b[1;5D");
    expect(encodeTerminalKey(ev({ key: "ArrowUp", altKey: true }))).toBe("\x1b[1;3A");
    expect(encodeTerminalKey(ev({ key: "ArrowUp", ctrlKey: true, altKey: true }))).toBe(
      "\x1b[1;7A",
    );
    expect(encodeTerminalKey(ev({ key: "Home", shiftKey: true }))).toBe("\x1b[1;2H");
    expect(encodeTerminalKey(ev({ key: "Delete", ctrlKey: true }))).toBe("\x1b[3;5~");
    // Modifiers force the CSI form even in application-cursor mode (xterm rule).
    expect(
      encodeTerminalKey(ev({ key: "ArrowUp", ctrlKey: true }), { applicationCursor: true }),
    ).toBe("\x1b[1;5A");
  });
});

describe("isPassthroughControlChord", () => {
  it("accepts the activity-control chords Ctrl+C/D/Z/L", () => {
    for (const key of ["c", "d", "z", "l"]) {
      expect(isPassthroughControlChord(ev({ key, ctrlKey: true }))).toBe(true);
    }
  });

  it("rejects everything else (paste, extra modifiers, plain keys)", () => {
    expect(isPassthroughControlChord(ev({ key: "v", ctrlKey: true }))).toBe(false); // paste stays in the draft
    expect(isPassthroughControlChord(ev({ key: "c", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPassthroughControlChord(ev({ key: "c", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPassthroughControlChord(ev({ key: "c" }))).toBe(false);
  });
});
