import { describe, it, expect } from "vitest";
import {
  computeHiddenPaneIds,
  advanceHiddenTimers,
  type HideCandidatePane,
} from "./hidden-auto-close";

const panes: HideCandidatePane[] = [
  { paneId: "p1", workspaceId: "wsA" },
  { paneId: "p2", workspaceId: "wsA" },
  { paneId: "p3", workspaceId: "wsB" },
];

describe("computeHiddenPaneIds", () => {
  it("marks individually hidden panes", () => {
    const result = computeHiddenPaneIds({
      panes,
      hiddenPaneIds: new Set(["p1"]),
      hiddenWorkspaceIds: new Set(),
      activeWorkspaceId: "wsB",
    });
    expect([...result]).toEqual(["p1"]);
  });

  it("marks all panes of a hidden workspace", () => {
    const result = computeHiddenPaneIds({
      panes,
      hiddenPaneIds: new Set(),
      hiddenWorkspaceIds: new Set(["wsA"]),
      activeWorkspaceId: "wsB",
    });
    expect([...result].sort()).toEqual(["p1", "p2"]);
  });

  it("never marks panes in the active workspace", () => {
    const result = computeHiddenPaneIds({
      panes,
      hiddenPaneIds: new Set(["p1"]),
      hiddenWorkspaceIds: new Set(["wsA"]),
      activeWorkspaceId: "wsA",
    });
    expect(result.size).toBe(0);
  });
});

describe("advanceHiddenTimers", () => {
  it("stamps newly hidden panes with the current time", () => {
    const { hiddenSince, evictPaneIds } = advanceHiddenTimers({
      hiddenPaneIds: new Set(["p1"]),
      hiddenSince: new Map(),
      now: 1000,
      timeoutMs: 5000,
    });
    expect(hiddenSince.get("p1")).toBe(1000);
    expect(evictPaneIds.size).toBe(0);
  });

  it("does not evict before the timeout elapses", () => {
    const { evictPaneIds } = advanceHiddenTimers({
      hiddenPaneIds: new Set(["p1"]),
      hiddenSince: new Map([["p1", 1000]]),
      now: 1000 + 4999,
      timeoutMs: 5000,
    });
    expect(evictPaneIds.size).toBe(0);
  });

  it("evicts once the timeout has elapsed", () => {
    const { evictPaneIds } = advanceHiddenTimers({
      hiddenPaneIds: new Set(["p1"]),
      hiddenSince: new Map([["p1", 1000]]),
      now: 1000 + 5000,
      timeoutMs: 5000,
    });
    expect([...evictPaneIds]).toEqual(["p1"]);
  });

  it("never evicts when timeout is 0 (disabled)", () => {
    const { evictPaneIds } = advanceHiddenTimers({
      hiddenPaneIds: new Set(["p1"]),
      hiddenSince: new Map([["p1", 0]]),
      now: 999_999_999,
      timeoutMs: 0,
    });
    expect(evictPaneIds.size).toBe(0);
  });

  it("drops panes that are no longer hidden (resets their timer)", () => {
    const { hiddenSince } = advanceHiddenTimers({
      hiddenPaneIds: new Set(["p2"]),
      hiddenSince: new Map([["p1", 1000]]),
      now: 2000,
      timeoutMs: 5000,
    });
    expect(hiddenSince.has("p1")).toBe(false);
    expect(hiddenSince.get("p2")).toBe(2000);
  });

  it("does not mutate the input map", () => {
    const input = new Map([["p1", 1000]]);
    advanceHiddenTimers({
      hiddenPaneIds: new Set(["p1"]),
      hiddenSince: input,
      now: 2000,
      timeoutMs: 5000,
    });
    expect(input.get("p1")).toBe(1000);
    expect(input.size).toBe(1);
  });
});
