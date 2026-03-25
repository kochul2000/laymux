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
