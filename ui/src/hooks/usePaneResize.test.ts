import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  findPaneBoundaries,
  calcResizeDelta,
  shouldMergeOnDragEnd,
  PANE_MIN_RATIO,
  type PaneBoundary,
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
});
