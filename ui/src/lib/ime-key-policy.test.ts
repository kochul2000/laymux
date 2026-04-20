import { describe, expect, it } from "vitest";

import { shouldDeferTerminalKeyToIme } from "./ime-key-policy";

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
