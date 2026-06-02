import { describe, it, expect } from "vitest";
import {
  computePaneNumbers,
  paneNumberFor,
  formatPaneIdentifier,
  type NumberablePane,
} from "./pane-numbers";

/** Build a pane with only the fields the numbering cares about. */
function p(id: string, x: number, y: number, w = 0.5, h = 0.5): NumberablePane {
  return { id, x, y, w, h };
}

describe("computePaneNumbers", () => {
  it("assigns 1 to a single pane", () => {
    const result = computePaneNumbers([p("a", 0, 0, 1, 1)]);
    expect(result.get("a")).toBe(1);
    expect(result.size).toBe(1);
  });

  it("numbers a left/right split left=1, right=2 (same row, x ascending)", () => {
    const result = computePaneNumbers([p("L", 0, 0, 0.5, 1), p("R", 0.5, 0, 0.5, 1)]);
    expect(result.get("L")).toBe(1);
    expect(result.get("R")).toBe(2);
  });

  it("numbers a top/bottom split top=1, bottom=2 (y first)", () => {
    const result = computePaneNumbers([p("T", 0, 0, 1, 0.5), p("B", 0, 0.5, 1, 0.5)]);
    expect(result.get("T")).toBe(1);
    expect(result.get("B")).toBe(2);
  });

  it("numbers a 2x2 grid in reading order (TL=1, TR=2, BL=3, BR=4)", () => {
    const result = computePaneNumbers([
      p("BR", 0.5, 0.5),
      p("TL", 0, 0),
      p("BL", 0, 0.5),
      p("TR", 0.5, 0),
    ]);
    expect(result.get("TL")).toBe(1);
    expect(result.get("TR")).toBe(2);
    expect(result.get("BL")).toBe(3);
    expect(result.get("BR")).toBe(4);
  });

  it("treats panes within eps (0.01) of each other on y as the same row", () => {
    // y=0.0 and y=0.009 are the same row -> sort by x. y=0.5 is a different row.
    const result = computePaneNumbers([
      p("rowB", 0, 0.5),
      p("rowA-right", 0.5, 0.009),
      p("rowA-left", 0, 0.0),
    ]);
    expect(result.get("rowA-left")).toBe(1);
    expect(result.get("rowA-right")).toBe(2);
    expect(result.get("rowB")).toBe(3);
  });

  it("numbers by spatial reading order regardless of array order", () => {
    // Array order [TL, BL, TR] (as produced by splice-based splitting) must still
    // yield reading-order numbers: TL=1, TR=2, BL=3.
    const result = computePaneNumbers([p("TL", 0, 0), p("BL", 0, 0.5), p("TR", 0.5, 0)]);
    expect(result.get("TL")).toBe(1);
    expect(result.get("TR")).toBe(2);
    expect(result.get("BL")).toBe(3);
  });

  it("numbers every pane regardless of view type (numbers are positional)", () => {
    const result = computePaneNumbers([p("a", 0, 0, 0.5, 1), p("b", 0.5, 0, 0.5, 1)]);
    expect(result.size).toBe(2);
  });

  it("does not mutate the input array", () => {
    const panes = [p("R", 0.5, 0), p("L", 0, 0)];
    const snapshot = panes.map((x) => x.id);
    computePaneNumbers(panes);
    expect(panes.map((x) => x.id)).toEqual(snapshot);
  });

  it("returns an empty map for no panes", () => {
    expect(computePaneNumbers([]).size).toBe(0);
  });
});

describe("formatPaneIdentifier", () => {
  it("includes a stable prefix so a human/LLM recognizes it as a pane identifier", () => {
    const s = formatPaneIdentifier({ workspaceId: "ws-a1b2c3d4", paneNumber: 3 });
    expect(s).toContain("laymux pane");
  });

  it("includes the workspace id and pane number that map to MCP write_to_terminal params", () => {
    const s = formatPaneIdentifier({ workspaceId: "ws-a1b2c3d4", paneNumber: 3 });
    expect(s).toContain("ws-a1b2c3d4");
    expect(s).toContain("workspace=ws-a1b2c3d4");
    expect(s).toContain("pane=3");
  });

  it("produces the canonical single-line format", () => {
    expect(formatPaneIdentifier({ workspaceId: "ws-a1b2c3d4", paneNumber: 3 })).toBe(
      "[laymux pane] workspace=ws-a1b2c3d4 pane=3",
    );
  });

  it("appends the workspace name as a human hint when provided", () => {
    expect(
      formatPaneIdentifier({
        workspaceId: "ws-a1b2c3d4",
        paneNumber: 2,
        workspaceName: "Backend",
      }),
    ).toBe('[laymux pane] workspace=ws-a1b2c3d4 ("Backend") pane=2');
  });

  it("omits the name hint when the name is empty or whitespace", () => {
    expect(formatPaneIdentifier({ workspaceId: "ws-x", paneNumber: 1, workspaceName: "   " })).toBe(
      "[laymux pane] workspace=ws-x pane=1",
    );
  });

  it("does not include a name hint when name is undefined", () => {
    const s = formatPaneIdentifier({ workspaceId: "ws-x", paneNumber: 1 });
    expect(s).not.toContain("(");
  });
});

describe("paneNumberFor", () => {
  it("returns the number for a known pane id", () => {
    const panes = [p("L", 0, 0, 0.5, 1), p("R", 0.5, 0, 0.5, 1)];
    expect(paneNumberFor(panes, "R")).toBe(2);
  });

  it("returns null for an unknown pane id", () => {
    expect(paneNumberFor([p("L", 0, 0)], "missing")).toBeNull();
  });
});
