import { describe, expect, it } from "vitest";

import { shouldBlockTerminalKeyDuringIme, shouldDeferTerminalKeyToIme } from "./ime-key-policy";

describe("shouldDeferTerminalKeyToIme", () => {
  it("returns false when composition is inactive", () => {
    expect(
      shouldDeferTerminalKeyToIme(false, {
        key: "a",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("defers printable keys during composition", () => {
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "a",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: " ",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("defers IME navigation and confirmation keys during composition", () => {
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "ArrowLeft",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "Enter",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("does not defer modified shortcuts during composition", () => {
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "c",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "v",
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  it("does not defer unrelated non-printable keys by default", () => {
    expect(
      shouldDeferTerminalKeyToIme(true, {
        key: "F5",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});

describe("shouldBlockTerminalKeyDuringIme", () => {
  const noMods = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false } as const;

  it("blocks IME mode-switch keys while composition is active", () => {
    for (const key of ["HangulMode", "HanjaMode", "KanaMode", "Convert", "ModeChange"]) {
      expect(shouldBlockTerminalKeyDuringIme(true, { key, ...noMods })).toBe(true);
    }
  });

  it("does not block mode-switch keys when composition is inactive", () => {
    expect(shouldBlockTerminalKeyDuringIme(false, { key: "HangulMode", ...noMods })).toBe(false);
  });

  it("does not block regular keys during composition", () => {
    expect(shouldBlockTerminalKeyDuringIme(true, { key: "a", ...noMods })).toBe(false);
    expect(shouldBlockTerminalKeyDuringIme(true, { key: "Enter", ...noMods })).toBe(false);
    expect(shouldBlockTerminalKeyDuringIme(true, { key: "Process", ...noMods })).toBe(false);
  });
});
