import { describe, it, expect } from "vitest";
import {
  DEFAULT_FAST_SCROLL_SENSITIVITY,
  DEFAULT_SCROLL_SENSITIVITY,
  normalizeScrollSensitivity,
  SCROLL_SENSITIVITY_MAX,
  SCROLL_SENSITIVITY_MIN,
} from "./scroll-sensitivity";

describe("normalizeScrollSensitivity", () => {
  it("keeps a value inside the supported band", () => {
    expect(normalizeScrollSensitivity(2.5)).toBe(2.5);
    expect(normalizeScrollSensitivity("3")).toBe(3);
  });

  it("snaps to the 0.1 step the settings UI offers", () => {
    expect(normalizeScrollSensitivity(1.234)).toBe(1.2);
  });

  it("clamps above the maximum", () => {
    expect(normalizeScrollSensitivity(1000)).toBe(SCROLL_SENSITIVITY_MAX);
  });

  it("clamps a positive value below the minimum", () => {
    expect(normalizeScrollSensitivity(0.01)).toBe(SCROLL_SENSITIVITY_MIN);
  });

  it("falls back for values xterm rejects outright", () => {
    // xterm throws on a non-positive sensitivity, so 0 and negatives are not
    // clamped up — the caller's default wins.
    expect(normalizeScrollSensitivity(0)).toBe(DEFAULT_SCROLL_SENSITIVITY);
    expect(normalizeScrollSensitivity(-4)).toBe(DEFAULT_SCROLL_SENSITIVITY);
    expect(normalizeScrollSensitivity("")).toBe(DEFAULT_SCROLL_SENSITIVITY);
    expect(normalizeScrollSensitivity("abc", DEFAULT_FAST_SCROLL_SENSITIVITY)).toBe(
      DEFAULT_FAST_SCROLL_SENSITIVITY,
    );
  });
});
