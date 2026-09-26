import { describe, expect, it } from "vitest";
import { lifecycleSteps, progressPercent } from "./lifecycle-progress";

describe("lifecycle progress", () => {
  it("skips optional cleanup without skipping durable restore or output saving", () => {
    expect(lifecycleSteps("close", false)).toEqual(["checkpoint", "caching", "closing"]);
    expect(lifecycleSteps("update", true)).toEqual([
      "downloading",
      "checkpoint",
      "interrupting",
      "caching",
      "installing",
    ]);
  });
  it("never invents a percentage for unknown work", () => {
    expect(progressPercent({ completed: 8, total: null })).toBeNull();
    expect(progressPercent({ completed: 12, total: 10 })).toBe(100);
    expect(progressPercent({ completed: 2, total: 3 })).toBe(66);
  });
});
