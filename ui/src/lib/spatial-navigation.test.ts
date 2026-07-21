import { describe, expect, it } from "vitest";

import type { Workspace, WorkspacePane } from "@/stores/types";

import {
  buildSpatialOrder,
  findSpatialStepTarget,
  type SpatialAnchor,
  type SpatialEntry,
} from "./spatial-navigation";

/** Terminal pane at the given normalized geometry. */
function term(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "TerminalView" } };
}

/** Non-terminal pane (memo) at the given geometry. */
function memo(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "MemoView" } };
}

function ws(id: string, name: string, panes: WorkspacePane[]): Workspace {
  return { id, name, panes };
}

/** Shorthand: [workspaceId, paneId] pairs from entries. */
function pairs(entries: SpatialEntry[]): Array<[string, string]> {
  return entries.map((e) => [e.workspaceId, e.paneId]);
}

describe("buildSpatialOrder", () => {
  it("flattens workspaces in display order, panes in reading order", () => {
    // ws1: b(top-right), a(top-left) — reading order a(1), b(2)
    const w1 = ws("ws1", "One", [term("b", 0.5, 0), term("a", 0, 0)]);
    // ws2: single pane
    const w2 = ws("ws2", "Two", [term("c", 0, 0, 1, 1)]);
    const entries = buildSpatialOrder([w1, w2]);
    expect(pairs(entries)).toEqual([
      ["ws1", "a"],
      ["ws1", "b"],
      ["ws2", "c"],
    ]);
    expect(entries[0].paneNumber).toBe(1);
    expect(entries[1].paneNumber).toBe(2);
  });

  it("keeps the original paneIndex, not the sorted position", () => {
    const w1 = ws("ws1", "One", [term("b", 0.5, 0), term("a", 0, 0)]);
    const entries = buildSpatialOrder([w1]);
    expect(entries[0]).toMatchObject({ paneId: "a", paneIndex: 1, paneNumber: 1 });
    expect(entries[1]).toMatchObject({ paneId: "b", paneIndex: 0, paneNumber: 2 });
  });

  it("excludes non-terminal panes but numbers around them", () => {
    // memo m is spatially first — terminal t must keep paneNumber 2 (badge consistency)
    const w1 = ws("ws1", "One", [memo("m", 0, 0), term("t", 0.5, 0)]);
    const entries = buildSpatialOrder([w1]);
    expect(pairs(entries)).toEqual([["ws1", "t"]]);
    expect(entries[0].paneNumber).toBe(2);
  });

  it("skips workspaces with no terminal panes", () => {
    const w1 = ws("ws1", "One", [memo("m", 0, 0, 1, 1)]);
    const w2 = ws("ws2", "Two", [term("t", 0, 0, 1, 1)]);
    expect(pairs(buildSpatialOrder([w1, w2]))).toEqual([["ws2", "t"]]);
  });

  it("removes explicitly excluded panes while preserving global order", () => {
    const w1 = ws("ws1", "One", [term("a", 0, 0), term("b", 0.5, 0)]);
    const w2 = ws("ws2", "Two", [term("c", 0, 0, 1, 1)]);

    const entries = buildSpatialOrder([w1, w2], new Set(["b"]));

    expect(pairs(entries)).toEqual([
      ["ws1", "a"],
      ["ws2", "c"],
    ]);
    expect(entries[1]).toMatchObject({ paneIndex: 0, paneNumber: 1 });
  });

  it("ignores stale exclusions and returns empty when every eligible pane is excluded", () => {
    const w1 = ws("ws1", "One", [term("a", 0, 0), term("b", 0.5, 0)]);

    expect(pairs(buildSpatialOrder([w1], new Set(["stale-pane"])))).toEqual([
      ["ws1", "a"],
      ["ws1", "b"],
    ]);
    expect(buildSpatialOrder([w1], new Set(["a", "b"]))).toEqual([]);
  });

  it("returns empty for no workspaces", () => {
    expect(buildSpatialOrder([])).toEqual([]);
  });
});

describe("findSpatialStepTarget", () => {
  // Global order: ws1:a(1), ws1:b(2), ws2:c(1)
  const w1 = ws("ws1", "One", [term("a", 0, 0), term("b", 0.5, 0)]);
  const w2 = ws("ws2", "Two", [term("c", 0, 0, 1, 1)]);
  const entries = buildSpatialOrder([w1, w2]);
  const order = ["ws1", "ws2"];

  const at = (workspaceId: string, paneNumber: number | null): SpatialAnchor => ({
    workspaceId,
    paneNumber,
  });

  it("steps to the next pane within a workspace", () => {
    const t = findSpatialStepTarget(entries, order, at("ws1", 1), "next");
    expect(t).toMatchObject({ workspaceId: "ws1", paneId: "b" });
  });

  it("crosses the workspace boundary forward", () => {
    const t = findSpatialStepTarget(entries, order, at("ws1", 2), "next");
    expect(t).toMatchObject({ workspaceId: "ws2", paneId: "c" });
  });

  it("crosses the workspace boundary backward", () => {
    const t = findSpatialStepTarget(entries, order, at("ws2", 1), "prev");
    expect(t).toMatchObject({ workspaceId: "ws1", paneId: "b" });
  });

  it("wraps from the last entry to the first", () => {
    const t = findSpatialStepTarget(entries, order, at("ws2", 1), "next");
    expect(t).toMatchObject({ workspaceId: "ws1", paneId: "a" });
  });

  it("wraps from the first entry to the last", () => {
    const t = findSpatialStepTarget(entries, order, at("ws1", 1), "prev");
    expect(t).toMatchObject({ workspaceId: "ws2", paneId: "c" });
  });

  it("returns null when there are no entries", () => {
    expect(findSpatialStepTarget([], order, at("ws1", 1), "next")).toBeNull();
  });

  it("returns null when the only entry is the anchor itself", () => {
    const solo = buildSpatialOrder([w2]);
    expect(findSpatialStepTarget(solo, ["ws2"], at("ws2", 1), "next")).toBeNull();
    expect(findSpatialStepTarget(solo, ["ws2"], at("ws2", 1), "prev")).toBeNull();
  });

  it("anchors on a non-entry pane (memo focused) without landing on it", () => {
    // ws1: memo m(1), term t(2); anchor = memo(paneNumber 1)
    const wm = ws("ws1", "One", [memo("m", 0, 0), term("t", 0.5, 0)]);
    const e = buildSpatialOrder([wm, w2]);
    const next = findSpatialStepTarget(e, order, at("ws1", 1), "next");
    expect(next).toMatchObject({ workspaceId: "ws1", paneId: "t" });
    const prev = findSpatialStepTarget(e, order, at("ws1", 1), "prev");
    expect(prev).toMatchObject({ workspaceId: "ws2", paneId: "c" });
  });

  it("anchors on a null pane (dock or no focus) at the start of the active workspace", () => {
    const next = findSpatialStepTarget(entries, order, at("ws2", null), "next");
    expect(next).toMatchObject({ workspaceId: "ws2", paneId: "c" });
    const prev = findSpatialStepTarget(entries, order, at("ws2", null), "prev");
    expect(prev).toMatchObject({ workspaceId: "ws1", paneId: "b" });
  });

  it("anchors on a hidden active workspace via the full order", () => {
    // ws-hidden sits between ws1 and ws2 in the full order but has no entries
    const fullOrder = ["ws1", "ws-hidden", "ws2"];
    const next = findSpatialStepTarget(entries, fullOrder, at("ws-hidden", 1), "next");
    expect(next).toMatchObject({ workspaceId: "ws2", paneId: "c" });
    const prev = findSpatialStepTarget(entries, fullOrder, at("ws-hidden", 1), "prev");
    expect(prev).toMatchObject({ workspaceId: "ws1", paneId: "b" });
  });

  it("hidden active workspace at the end wraps forward to the first entry", () => {
    const fullOrder = ["ws1", "ws2", "ws-hidden"];
    const next = findSpatialStepTarget(entries, fullOrder, at("ws-hidden", 1), "next");
    expect(next).toMatchObject({ workspaceId: "ws1", paneId: "a" });
  });

  it("falls back to the boundary entry for an unknown anchor workspace", () => {
    expect(findSpatialStepTarget(entries, order, at("ws-gone", 1), "next")).toMatchObject({
      paneId: "a",
    });
    expect(findSpatialStepTarget(entries, order, at("ws-gone", 1), "prev")).toMatchObject({
      paneId: "c",
    });
  });
});
