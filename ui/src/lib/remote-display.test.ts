import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_COMPOSER_FONT_SIZE,
  DEFAULT_REMOTE_TERMINAL_FONT_SIZE,
  normalizeRemoteFontSize,
  REMOTE_FONT_SIZE_MAX,
  REMOTE_FONT_SIZE_MIN,
} from "./remote-display";

describe("remote display settings", () => {
  it("keeps the existing 14px Remote defaults", () => {
    expect(DEFAULT_REMOTE_TERMINAL_FONT_SIZE).toBe(14);
    expect(DEFAULT_REMOTE_COMPOSER_FONT_SIZE).toBe(14);
  });

  it("rounds and clamps font sizes to the Remote display band", () => {
    expect(normalizeRemoteFontSize(15.6)).toBe(16);
    expect(normalizeRemoteFontSize(0)).toBe(REMOTE_FONT_SIZE_MIN);
    expect(normalizeRemoteFontSize(999)).toBe(REMOTE_FONT_SIZE_MAX);
  });
});
