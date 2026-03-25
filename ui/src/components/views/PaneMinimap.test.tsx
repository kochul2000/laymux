import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PaneMinimap } from "./PaneMinimap";

describe("PaneMinimap", () => {
  const twoPanes = [
    { x: 0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ];

  const threePanes = [
    { x: 0, y: 0, w: 1, h: 0.6 },
    { x: 0, y: 0.6, w: 0.5, h: 0.4 },
    { x: 0.5, y: 0.6, w: 0.5, h: 0.4 },
  ];

  it("renders an SVG element", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    expect(svg.tagName).toBe("svg");
  });

  it("renders with default 18x12 dimensions", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("12");
  });

  it("renders one rect per pane", () => {
    render(<PaneMinimap panes={threePanes} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");
    expect(rects).toHaveLength(3);
  });

  it("applies proportional position and size to pane rects", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");

    // First pane: x=0, y=0, w=50%, h=100% of 18x12 → 0, 0, 9, 12
    const r0 = rects[0];
    expect(Number(r0.getAttribute("x"))).toBeCloseTo(0);
    expect(Number(r0.getAttribute("y"))).toBeCloseTo(0);
    expect(Number(r0.getAttribute("width"))).toBeCloseTo(9);
    expect(Number(r0.getAttribute("height"))).toBeCloseTo(12);

    // Second pane: x=50%, y=0, w=50%, h=100% → 9, 0, 9, 12
    const r1 = rects[1];
    expect(Number(r1.getAttribute("x"))).toBeCloseTo(9);
    expect(Number(r1.getAttribute("y"))).toBeCloseTo(0);
    expect(Number(r1.getAttribute("width"))).toBeCloseTo(9);
    expect(Number(r1.getAttribute("height"))).toBeCloseTo(12);
  });

  it("highlights only the specified pane index", () => {
    render(<PaneMinimap panes={threePanes} highlightIndex={1} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");

    // Pane 0 and 2 should NOT be highlighted
    expect(rects[0].getAttribute("data-highlighted")).toBe("false");
    expect(rects[2].getAttribute("data-highlighted")).toBe("false");
    // Pane 1 should be highlighted
    expect(rects[1].getAttribute("data-highlighted")).toBe("true");
  });

  it("renders outer border rect", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    const border = svg.querySelector("rect[data-testid='minimap-border']");
    expect(border).toBeInTheDocument();
  });

  it("handles single pane (full workspace)", () => {
    const singlePane = [{ x: 0, y: 0, w: 1, h: 1 }];
    render(<PaneMinimap panes={singlePane} highlightIndex={0} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");
    expect(rects).toHaveLength(1);
    expect(rects[0].getAttribute("data-highlighted")).toBe("true");
    expect(Number(rects[0].getAttribute("width"))).toBeCloseTo(18);
    expect(Number(rects[0].getAttribute("height"))).toBeCloseTo(12);
  });

  it("handles many panes (10+)", () => {
    const manyPanes = Array.from({ length: 12 }, (_, i) => ({
      x: (i % 4) * 0.25,
      y: Math.floor(i / 4) * (1 / 3),
      w: 0.25,
      h: 1 / 3,
    }));
    render(<PaneMinimap panes={manyPanes} highlightIndex={5} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");
    expect(rects).toHaveLength(12);
    expect(rects[5].getAttribute("data-highlighted")).toBe("true");
  });

  it("accepts custom width and height", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={0} width={48} height={36} />);
    const svg = screen.getByTestId("pane-minimap");
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.getAttribute("height")).toBe("36");
  });

  it("does not highlight when highlightIndex is -1", () => {
    render(<PaneMinimap panes={twoPanes} highlightIndex={-1} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");
    expect(rects[0].getAttribute("data-highlighted")).toBe("false");
    expect(rects[1].getAttribute("data-highlighted")).toBe("false");
  });

  it("renders three-pane layout with correct proportions", () => {
    // Top pane: full width, 60% height. Bottom-left: 50% width, 40% height. Bottom-right: same.
    render(<PaneMinimap panes={threePanes} highlightIndex={2} />);
    const svg = screen.getByTestId("pane-minimap");
    const rects = svg.querySelectorAll("rect[data-pane-index]");

    // Top pane: 0, 0, 18, 7.2
    const r0 = rects[0];
    expect(Number(r0.getAttribute("x"))).toBeCloseTo(0);
    expect(Number(r0.getAttribute("y"))).toBeCloseTo(0);
    expect(Number(r0.getAttribute("width"))).toBeCloseTo(18);
    expect(Number(r0.getAttribute("height"))).toBeCloseTo(7.2);

    // Bottom-left: 0, 7.2, 9, 4.8
    const r1 = rects[1];
    expect(Number(r1.getAttribute("x"))).toBeCloseTo(0);
    expect(Number(r1.getAttribute("y"))).toBeCloseTo(7.2);
    expect(Number(r1.getAttribute("width"))).toBeCloseTo(9);
    expect(Number(r1.getAttribute("height"))).toBeCloseTo(4.8);

    // Bottom-right (highlighted): 9, 7.2, 9, 4.8
    const r2 = rects[2];
    expect(Number(r2.getAttribute("x"))).toBeCloseTo(9);
    expect(Number(r2.getAttribute("y"))).toBeCloseTo(7.2);
    expect(Number(r2.getAttribute("width"))).toBeCloseTo(9);
    expect(Number(r2.getAttribute("height"))).toBeCloseTo(4.8);
    expect(r2.getAttribute("data-highlighted")).toBe("true");
  });
});
