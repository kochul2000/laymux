import { describe, it, expect } from "vitest";
import { findPaneInDirection } from "./pane-navigation";

// Helper: create a pane-like object with position
function pane(x: number, y: number, w: number, h: number) {
  return { x, y, w, h };
}

describe("findPaneInDirection", () => {
  // 2-column layout: [left | right]
  const twoCols = [
    pane(0, 0, 0.5, 1), // 0: left
    pane(0.5, 0, 0.5, 1), // 1: right
  ];

  it("moves right from left pane", () => {
    expect(findPaneInDirection(twoCols, 0, "right")).toBe(1);
  });

  it("moves left from right pane", () => {
    expect(findPaneInDirection(twoCols, 1, "left")).toBe(0);
  });

  it("returns null when no pane in direction", () => {
    expect(findPaneInDirection(twoCols, 0, "left")).toBeNull();
    expect(findPaneInDirection(twoCols, 1, "right")).toBeNull();
    expect(findPaneInDirection(twoCols, 0, "up")).toBeNull();
    expect(findPaneInDirection(twoCols, 0, "down")).toBeNull();
  });

  // 2-row layout: [top / bottom]
  const twoRows = [
    pane(0, 0, 1, 0.5), // 0: top
    pane(0, 0.5, 1, 0.5), // 1: bottom
  ];

  it("moves down from top pane", () => {
    expect(findPaneInDirection(twoRows, 0, "down")).toBe(1);
  });

  it("moves up from bottom pane", () => {
    expect(findPaneInDirection(twoRows, 1, "up")).toBe(0);
  });

  // 2x2 grid:
  // [TL | TR]
  // [BL | BR]
  const grid2x2 = [
    pane(0, 0, 0.5, 0.5), // 0: top-left
    pane(0.5, 0, 0.5, 0.5), // 1: top-right
    pane(0, 0.5, 0.5, 0.5), // 2: bottom-left
    pane(0.5, 0.5, 0.5, 0.5), // 3: bottom-right
  ];

  it("navigates right in 2x2 grid", () => {
    expect(findPaneInDirection(grid2x2, 0, "right")).toBe(1);
    expect(findPaneInDirection(grid2x2, 2, "right")).toBe(3);
  });

  it("navigates left in 2x2 grid", () => {
    expect(findPaneInDirection(grid2x2, 1, "left")).toBe(0);
    expect(findPaneInDirection(grid2x2, 3, "left")).toBe(2);
  });

  it("navigates down in 2x2 grid", () => {
    expect(findPaneInDirection(grid2x2, 0, "down")).toBe(2);
    expect(findPaneInDirection(grid2x2, 1, "down")).toBe(3);
  });

  it("navigates up in 2x2 grid", () => {
    expect(findPaneInDirection(grid2x2, 2, "up")).toBe(0);
    expect(findPaneInDirection(grid2x2, 3, "up")).toBe(1);
  });

  // Dev-split layout from ARCHITECTURE.md:
  // [    terminal (full width)    ]  top 60%
  // [ terminal 50% | browser 50% ]  bottom 40%
  const devSplit = [
    pane(0, 0, 1, 0.6), // 0: top full-width terminal
    pane(0, 0.6, 0.5, 0.4), // 1: bottom-left terminal
    pane(0.5, 0.6, 0.5, 0.4), // 2: bottom-right browser
  ];

  it("moves down from top full-width pane to closest bottom pane", () => {
    // Center of top pane is (0.5, 0.3), both bottom panes are equidistant
    // bottom-left center (0.25, 0.8), bottom-right center (0.75, 0.8)
    // Either is acceptable, but left should win (first match / smaller index)
    const result = findPaneInDirection(devSplit, 0, "down");
    expect(result === 1 || result === 2).toBe(true);
  });

  it("moves up from bottom-left to top pane", () => {
    expect(findPaneInDirection(devSplit, 1, "up")).toBe(0);
  });

  it("moves right from bottom-left to bottom-right", () => {
    expect(findPaneInDirection(devSplit, 1, "right")).toBe(2);
  });

  it("moves left from bottom-right to bottom-left", () => {
    expect(findPaneInDirection(devSplit, 2, "left")).toBe(1);
  });

  // Edge cases
  it("returns null for single pane", () => {
    expect(findPaneInDirection([pane(0, 0, 1, 1)], 0, "right")).toBeNull();
  });

  it("returns null for invalid index", () => {
    expect(findPaneInDirection(twoCols, -1, "right")).toBeNull();
    expect(findPaneInDirection(twoCols, 5, "right")).toBeNull();
  });

  it("returns null for empty panes", () => {
    expect(findPaneInDirection([], 0, "right")).toBeNull();
  });
});
