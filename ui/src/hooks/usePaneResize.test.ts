import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  findPaneBoundaries,
  calcResizeDelta,
  shouldMergeOnDragEnd,
  boundaryResizeUpdates,
  applyPaneResizeUpdates,
  findPaneAxisBoundary,
  planPaneResize,
  PANE_MIN_RATIO,
  type PaneBoundary,
  type GridRect,
} from "@/hooks/usePaneResize";
import type { WorkspacePane } from "@/stores/types";

describe("usePaneResize", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  });

  describe("findPaneBoundaries", () => {
    it("finds vertical boundary between two side-by-side panes", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
      ];
      const boundaries = findPaneBoundaries(panes);
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].direction).toBe("vertical");
      expect(boundaries[0].position).toBeCloseTo(0.5);
      expect(boundaries[0].leftPaneIndices).toContain(0);
      expect(boundaries[0].rightPaneIndices).toContain(1);
    });

    it("finds horizontal boundary between stacked panes", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 1, h: 0.5, view: { type: "EmptyView" } },
        { id: "p2", x: 0, y: 0.5, w: 1, h: 0.5, view: { type: "EmptyView" } },
      ];
      const boundaries = findPaneBoundaries(panes);
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].direction).toBe("horizontal");
      expect(boundaries[0].position).toBeCloseTo(0.5);
      expect(boundaries[0].leftPaneIndices).toContain(0);
      expect(boundaries[0].rightPaneIndices).toContain(1);
    });

    it("finds multiple boundaries in a 3-pane layout", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 1, h: 0.5, view: { type: "EmptyView" } },
        { id: "p2", x: 0, y: 0.5, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "p3", x: 0.5, y: 0.5, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
      ];
      const boundaries = findPaneBoundaries(panes);
      // Horizontal at y=0.5 (between pane 0 and panes 1,2)
      // Vertical at x=0.5 in range y=0.5..1.0 (between panes 1 and 2)
      expect(boundaries.length).toBeGreaterThanOrEqual(2);
    });

    it("merges adjacent vertical boundary segments so stacked panes resize together", () => {
      const panes: WorkspacePane[] = [
        { id: "left", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "right-top", x: 0.5, y: 0, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "right-bottom", x: 0.5, y: 0.5, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
      ];

      const boundaries = findPaneBoundaries(panes);
      const vertical = boundaries.filter((bd) => bd.direction === "vertical");

      expect(vertical).toHaveLength(1);
      expect(vertical[0].position).toBeCloseTo(0.5);
      expect(vertical[0].start).toBeCloseTo(0);
      expect(vertical[0].end).toBeCloseTo(1);
      expect(vertical[0].leftPaneIndices).toEqual([0]);
      expect(vertical[0].rightPaneIndices.sort()).toEqual([1, 2]);
    });

    it("merges adjacent horizontal boundary segments so side-by-side panes resize together", () => {
      const panes: WorkspacePane[] = [
        { id: "top-left", x: 0, y: 0, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "top-right", x: 0.5, y: 0, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "bottom", x: 0, y: 0.5, w: 1, h: 0.5, view: { type: "EmptyView" } },
      ];

      const boundaries = findPaneBoundaries(panes);
      const horizontal = boundaries.filter((bd) => bd.direction === "horizontal");

      expect(horizontal).toHaveLength(1);
      expect(horizontal[0].position).toBeCloseTo(0.5);
      expect(horizontal[0].start).toBeCloseTo(0);
      expect(horizontal[0].end).toBeCloseTo(1);
      expect(horizontal[0].leftPaneIndices.sort()).toEqual([0, 1]);
      expect(horizontal[0].rightPaneIndices).toEqual([2]);
    });

    it("merges three or more adjacent vertical segments into a single boundary", () => {
      // Layout [2, [1, 1, 1]] — left full-height, right split into three stacked panes
      const panes: WorkspacePane[] = [
        { id: "left", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "r-top", x: 0.5, y: 0, w: 0.5, h: 1 / 3, view: { type: "EmptyView" } },
        { id: "r-mid", x: 0.5, y: 1 / 3, w: 0.5, h: 1 / 3, view: { type: "EmptyView" } },
        { id: "r-bot", x: 0.5, y: 2 / 3, w: 0.5, h: 1 / 3, view: { type: "EmptyView" } },
      ];

      const vertical = findPaneBoundaries(panes).filter((bd) => bd.direction === "vertical");

      expect(vertical).toHaveLength(1);
      expect(vertical[0].start).toBeCloseTo(0);
      expect(vertical[0].end).toBeCloseTo(1);
      expect(vertical[0].leftPaneIndices).toEqual([0]);
      expect(vertical[0].rightPaneIndices.sort()).toEqual([1, 2, 3]);
    });

    it("merges segments even when sub-split sizes are uneven", () => {
      // Right side split into uneven heights (e.g., user resized the inner boundary)
      const panes: WorkspacePane[] = [
        { id: "left", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "right-top", x: 0.5, y: 0, w: 0.5, h: 0.7, view: { type: "EmptyView" } },
        { id: "right-bottom", x: 0.5, y: 0.7, w: 0.5, h: 0.3, view: { type: "EmptyView" } },
      ];

      const vertical = findPaneBoundaries(panes).filter((bd) => bd.direction === "vertical");

      expect(vertical).toHaveLength(1);
      expect(vertical[0].start).toBeCloseTo(0);
      expect(vertical[0].end).toBeCloseTo(1);
      expect(vertical[0].leftPaneIndices).toEqual([0]);
      expect(vertical[0].rightPaneIndices.sort()).toEqual([1, 2]);
    });

    it("merges 2x2 grid boundary so dragging moves all four panes together", () => {
      const panes: WorkspacePane[] = [
        { id: "tl", x: 0, y: 0, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "tr", x: 0.5, y: 0, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "bl", x: 0, y: 0.5, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
        { id: "br", x: 0.5, y: 0.5, w: 0.5, h: 0.5, view: { type: "EmptyView" } },
      ];

      const vertical = findPaneBoundaries(panes).filter((bd) => bd.direction === "vertical");

      expect(vertical).toHaveLength(1);
      expect(vertical[0].leftPaneIndices.sort()).toEqual([0, 2]);
      expect(vertical[0].rightPaneIndices.sort()).toEqual([1, 3]);
    });

    it("keeps same-position boundary segments separate when their ranges are disconnected", () => {
      const panes: WorkspacePane[] = [
        { id: "left-top", x: 0, y: 0, w: 0.5, h: 0.25, view: { type: "EmptyView" } },
        { id: "right-top", x: 0.5, y: 0, w: 0.5, h: 0.25, view: { type: "EmptyView" } },
        { id: "middle", x: 0, y: 0.25, w: 1, h: 0.5, view: { type: "EmptyView" } },
        { id: "left-bottom", x: 0, y: 0.75, w: 0.5, h: 0.25, view: { type: "EmptyView" } },
        { id: "right-bottom", x: 0.5, y: 0.75, w: 0.5, h: 0.25, view: { type: "EmptyView" } },
      ];

      const vertical = findPaneBoundaries(panes).filter((bd) => bd.direction === "vertical");

      expect(vertical).toHaveLength(2);
      expect(vertical.map((bd) => [bd.start, bd.end])).toEqual([
        [0, 0.25],
        [0.75, 1],
      ]);
    });

    it("returns empty for single pane", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } },
      ];
      const boundaries = findPaneBoundaries(panes);
      expect(boundaries).toHaveLength(0);
    });
  });

  describe("calcResizeDelta", () => {
    it("calculates correct delta for vertical boundary drag", () => {
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.5,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      // Drag right by 0.1
      const delta = calcResizeDelta(boundary, 0.1);
      expect(delta).toBeCloseTo(0.1);
    });

    it("clamps delta to enforce minimum pane size", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.5,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      // Try to drag right by 0.49 — should be clamped so right pane stays >= MIN
      const delta = calcResizeDelta(boundary, 0.49, panes);
      const rightNewW = 0.5 - delta;
      // Allow float tolerance
      expect(rightNewW + 1e-10).toBeGreaterThanOrEqual(PANE_MIN_RATIO);
    });

    it("clamps negative delta to not shrink left pane below minimum", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.5,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      const delta = calcResizeDelta(boundary, -0.49, panes);
      const leftNewW = 0.5 + delta;
      // Allow float tolerance
      expect(leftNewW + 1e-10).toBeGreaterThanOrEqual(PANE_MIN_RATIO);
    });
  });

  describe("shouldMergeOnDragEnd", () => {
    it("returns indices to remove when right pane is at minimum size", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.95, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.95, y: 0, w: 0.05, h: 1, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.95,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      const result = shouldMergeOnDragEnd(boundary, panes);
      expect(result).toEqual([1]);
    });

    it("returns indices to remove when left pane is at minimum size", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.05, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.05, y: 0, w: 0.95, h: 1, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.05,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      const result = shouldMergeOnDragEnd(boundary, panes);
      expect(result).toEqual([0]);
    });

    it("returns indices for horizontal drag-to-edge", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 1, h: 0.95, view: { type: "EmptyView" } },
        { id: "p2", x: 0, y: 0.95, w: 1, h: 0.05, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "horizontal",
        position: 0.95,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      const result = shouldMergeOnDragEnd(boundary, panes);
      expect(result).toEqual([1]);
    });

    it("returns null when no pane is at minimum size", () => {
      const panes: WorkspacePane[] = [
        { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
        { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
      ];
      const boundary: PaneBoundary = {
        direction: "vertical",
        position: 0.5,
        leftPaneIndices: [0],
        rightPaneIndices: [1],
        start: 0,
        end: 1,
      };
      const result = shouldMergeOnDragEnd(boundary, panes);
      expect(result).toBeNull();
    });
  });

  describe("PANE_MIN_RATIO", () => {
    it("is a positive number less than 0.5", () => {
      expect(PANE_MIN_RATIO).toBeGreaterThan(0);
      expect(PANE_MIN_RATIO).toBeLessThan(0.5);
    });
  });

  // ── issue #590: neighbor-aware resize shared by drag and the automation API ──

  /** pane0 (0,0,.5,.5) / pane1 (0,.5,.5,.5) / pane2 (.5,0,.5,1) — a T-junction. */
  const tJunction: GridRect[] = [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ];

  function expectTiled(panes: GridRect[]) {
    for (let i = 0; i < panes.length; i++) {
      for (let j = i + 1; j < panes.length; j++) {
        const a = panes[i];
        const b = panes[j];
        const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(Math.max(0, xOverlap) * Math.max(0, yOverlap)).toBeLessThan(1e-9);
      }
    }
    const area = panes.reduce((sum, p) => sum + p.w * p.h, 0);
    expect(area).toBeCloseTo(1, 6);
  }

  describe("boundaryResizeUpdates", () => {
    it("moves both sides of the boundary so they stay flush", () => {
      const panes: GridRect[] = [
        { x: 0, y: 0, w: 0.5, h: 1 },
        { x: 0.5, y: 0, w: 0.5, h: 1 },
      ];
      const boundary = findPaneBoundaries(panes)[0];
      const updates = boundaryResizeUpdates(boundary, 0.1, panes);
      expect(applyPaneResizeUpdates(panes, updates)).toEqual([
        { x: 0, y: 0, w: 0.6, h: 1 },
        { x: 0.6, y: 0, w: 0.4, h: 1 },
      ]);
    });

    it("returns no updates when the clamped delta is negligible", () => {
      const panes: GridRect[] = [
        { x: 0, y: 0, w: 0.5, h: 1 },
        { x: 0.5, y: 0, w: 0.5, h: 1 },
      ];
      const boundary = findPaneBoundaries(panes)[0];
      expect(boundaryResizeUpdates(boundary, 0.0001, panes)).toEqual([]);
      // Neighbor is already at the minimum — a further grow is clamped away.
      const pinned: GridRect[] = [
        { x: 0, y: 0, w: 1 - PANE_MIN_RATIO, h: 1 },
        { x: 1 - PANE_MIN_RATIO, y: 0, w: PANE_MIN_RATIO, h: 1 },
      ];
      expect(boundaryResizeUpdates(findPaneBoundaries(pinned)[0], 0.2, pinned)).toEqual([]);
    });
  });

  describe("findPaneAxisBoundary", () => {
    it("prefers the trailing edge and reports a positive sign", () => {
      const resolved = findPaneAxisBoundary(tJunction, 0, "w");
      expect(resolved).not.toBeNull();
      expect(resolved!.sign).toBe(1);
      expect(resolved!.boundary.position).toBeCloseTo(0.5);
      // T-junction: the merged segment carries both stacked panes on the left.
      expect([...resolved!.boundary.leftPaneIndices].sort()).toEqual([0, 1]);
      expect(resolved!.boundary.rightPaneIndices).toEqual([2]);
    });

    it("falls back to the leading edge with an inverted sign at the grid edge", () => {
      const resolved = findPaneAxisBoundary(tJunction, 2, "w");
      expect(resolved).not.toBeNull();
      expect(resolved!.sign).toBe(-1);
      expect(resolved!.boundary.position).toBeCloseTo(0.5);
    });

    it("returns null when the pane spans the whole axis", () => {
      expect(findPaneAxisBoundary(tJunction, 2, "h")).toBeNull();
      expect(findPaneAxisBoundary([{ x: 0, y: 0, w: 1, h: 1 }], 0, "w")).toBeNull();
    });
  });

  describe("planPaneResize", () => {
    it("keeps a T-junction tiled across the issue #590 delta sequence", () => {
      let panes = tJunction;
      for (const dw of [0.08, -0.06, 0.05, -0.04, 0.03, 0.02]) {
        const plan = planPaneResize(panes, 0, { w: dw });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        panes = applyPaneResizeUpdates(panes, plan.updates);
        expectTiled(panes);
      }
      expect(panes[0].w).toBeCloseTo(0.58, 6);
      expect(panes[1].w).toBeCloseTo(0.58, 6);
      expect(panes[2].x).toBeCloseTo(0.58, 6);
      expect(panes[2].w).toBeCloseTo(0.42, 6);
    });

    it("grows an edge pane inward by inverting the leading boundary", () => {
      const plan = planPaneResize(tJunction, 2, { w: 0.1 });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const panes = applyPaneResizeUpdates(tJunction, plan.updates);
      expectTiled(panes);
      expect(panes[2]).toEqual({ x: 0.4, y: 0, w: 0.6, h: 1 });
    });

    it("resolves w and h against separate boundaries in one plan", () => {
      const plan = planPaneResize(tJunction, 0, { w: 0.1, h: 0.2 });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const panes = applyPaneResizeUpdates(tJunction, plan.updates);
      expectTiled(panes);
      expect(panes[0].w).toBeCloseTo(0.6, 6);
      expect(panes[0].h).toBeCloseTo(0.7, 6);
      expect(panes[1].y).toBeCloseTo(0.7, 6);
      // The horizontal boundary was recomputed after the width change, so the
      // stacked pane followed pane 0's new width instead of the old one.
      expect(panes[1].w).toBeCloseTo(0.6, 6);
      expect(panes[2].x).toBeCloseTo(0.6, 6);
    });

    it("clamps rather than shrinking a neighbor below the minimum", () => {
      const plan = planPaneResize(tJunction, 0, { w: 0.9 });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const panes = applyPaneResizeUpdates(tJunction, plan.updates);
      expectTiled(panes);
      expect(panes[2].w).toBeCloseTo(PANE_MIN_RATIO, 6);
    });

    it("errors when the pane owns no boundary on the requested axis", () => {
      const noRow = planPaneResize(tJunction, 2, { h: 0.1 });
      expect(noRow.ok).toBe(false);
      if (noRow.ok) return;
      expect(noRow.error).toMatch(/no horizontal boundary/);

      const solo = planPaneResize([{ x: 0, y: 0, w: 1, h: 1 }], 0, { w: 0.1 });
      expect(solo.ok).toBe(false);
    });

    it("errors on an out-of-range index or an empty delta", () => {
      expect(planPaneResize(tJunction, 7, { w: 0.1 }).ok).toBe(false);
      expect(planPaneResize(tJunction, -1, { w: 0.1 }).ok).toBe(false);
      expect(planPaneResize(tJunction, 0, {}).ok).toBe(false);
    });
  });
});
