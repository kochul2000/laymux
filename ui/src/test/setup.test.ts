import { describe, expect, it, vi } from "vitest";

describe("jsdom canvas boundary", () => {
  it("models an unavailable canvas context with an explicit API mock", () => {
    const canvas = document.createElement("canvas");

    expect(vi.isMockFunction(canvas.getContext)).toBe(true);
    expect(canvas.getContext("2d")).toBeNull();
  });
});
