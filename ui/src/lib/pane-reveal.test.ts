import { describe, it, expect } from "vitest";
import {
  orderedRevealIds,
  baselineReveal,
  reconcileReveal,
  addNextRevealBatch,
  isRevealComplete,
} from "./pane-reveal";

const arr = (s: ReadonlySet<string>) => [...s];

describe("orderedRevealIds", () => {
  it("hoists the focused pane to the front", () => {
    expect(orderedRevealIds(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
  it("returns the array unchanged when focused is null or absent", () => {
    expect(orderedRevealIds(["a", "b"], null)).toEqual(["a", "b"]);
    expect(orderedRevealIds(["a", "b"], "z")).toEqual(["a", "b"]);
  });
});

describe("baselineReveal", () => {
  it("takes the first initialBatch in reveal order (focused first)", () => {
    expect(arr(baselineReveal(["a", "b", "c", "d", "e"], "d", 2, false))).toEqual(["d", "a"]);
  });
  it("returns all ids when revealAll", () => {
    expect(arr(baselineReveal(["a", "b", "c"], null, 1, true)).sort()).toEqual(["a", "b", "c"]);
  });
  it("never exceeds the pane count", () => {
    expect(baselineReveal(["a"], null, 4, false).size).toBe(1);
  });
});

describe("reconcileReveal", () => {
  it("prunes ids that no longer exist", () => {
    const prev = new Set(["a", "b", "gone"]);
    const next = reconcileReveal(prev, ["a", "b"], null, 4, false);
    expect(arr(next).sort()).toEqual(["a", "b"]);
  });
  it("keeps already-revealed present ids (add-only invariant)", () => {
    // 6 panes, batch 2, but c/d/e already revealed → must stay revealed.
    const prev = new Set(["a", "b", "c", "d", "e"]);
    const next = reconcileReveal(prev, ["a", "b", "c", "d", "e", "f"], null, 2, false);
    expect(arr(next).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("guarantees the baseline (focused + initial batch) is present", () => {
    const next = reconcileReveal(new Set(), ["a", "b", "c", "d", "e"], "e", 2, false);
    expect(arr(next).sort()).toEqual(["a", "e"]);
  });
  it("returns the same reference when nothing changes", () => {
    const prev = new Set(["a", "b"]);
    expect(reconcileReveal(prev, ["a", "b"], null, 4, true)).toBe(prev);
  });
});

describe("addNextRevealBatch", () => {
  it("reveals perFrame more ids in reveal order", () => {
    const next = addNextRevealBatch(new Set(["a"]), ["a", "b", "c", "d"], null, 2);
    expect(arr(next)).toEqual(["a", "b", "c"]);
  });
  it("reveals the focused pane first when still hidden", () => {
    const next = addNextRevealBatch(new Set(["a"]), ["a", "b", "c", "d"], "d", 1);
    expect(arr(next)).toEqual(["a", "d"]);
  });
  it("returns the same reference when nothing left to reveal", () => {
    const prev = new Set(["a", "b"]);
    expect(addNextRevealBatch(prev, ["a", "b"], null, 2)).toBe(prev);
  });
});

describe("isRevealComplete", () => {
  it("is true only when every present pane is revealed", () => {
    expect(isRevealComplete(new Set(["a", "b"]), ["a", "b"])).toBe(true);
    expect(isRevealComplete(new Set(["a"]), ["a", "b"])).toBe(false);
  });
});
