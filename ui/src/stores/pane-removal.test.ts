import { describe, it, expect } from "vitest";
import { removePaneAndRedistribute } from "./pane-removal";

interface TestPane {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
}

function p(id: string, x: number, y: number, w: number, h: number): TestPane {
  return { id, x, y, w, h };
}

/** Validate that panes form a valid non-overlapping layout filling the full area. */
function validateLayout(panes: TestPane[]) {
  const EPSILON = 0.001;

  // All panes within [0, 1] bounds
  for (const pane of panes) {
    expect(pane.x).toBeGreaterThanOrEqual(-EPSILON);
    expect(pane.y).toBeGreaterThanOrEqual(-EPSILON);
    expect(pane.x + pane.w).toBeLessThanOrEqual(1.0 + EPSILON);
    expect(pane.y + pane.h).toBeLessThanOrEqual(1.0 + EPSILON);
    expect(pane.w).toBeGreaterThan(0);
    expect(pane.h).toBeGreaterThan(0);
  }

  // Total area should be ~1.0
  const totalArea = panes.reduce((sum, pn) => sum + pn.w * pn.h, 0);
  expect(totalArea).toBeCloseTo(1.0, 3);

  // No overlapping panes (check pairwise intersection area)
  for (let i = 0; i < panes.length; i++) {
    for (let j = i + 1; j < panes.length; j++) {
      const a = panes[i];
      const b = panes[j];
      const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const overlapArea = overlapX * overlapY;
      expect(overlapArea, `Panes ${a.id} and ${b.id} overlap`).toBeLessThan(EPSILON);
    }
  }
}

describe("removePaneAndRedistribute", () => {
  // === Edge cases ===

  it("returns null for single pane (cannot remove last)", () => {
    const panes = [p("A", 0, 0, 1, 1)];
    expect(removePaneAndRedistribute(panes, 0)).toBeNull();
  });

  it("returns null for invalid index (negative)", () => {
    const panes = [p("A", 0, 0, 0.5, 1), p("B", 0.5, 0, 0.5, 1)];
    expect(removePaneAndRedistribute(panes, -1)).toBeNull();
  });

  it("returns null for invalid index (out of bounds)", () => {
    const panes = [p("A", 0, 0, 0.5, 1), p("B", 0.5, 0, 0.5, 1)];
    expect(removePaneAndRedistribute(panes, 5)).toBeNull();
  });

  // === Two panes (basic splits) ===

  describe("two panes side by side (vertical split)", () => {
    //  ┌────┬────┐
    //  │ A  │ B  │
    //  └────┴────┘
    const panes = () => [p("A", 0, 0, 0.5, 1), p("B", 0.5, 0, 0.5, 1)];

    it("remove left → right expands to full width", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("B");
      expect(result[0].x).toBeCloseTo(0);
      expect(result[0].w).toBeCloseTo(1);
      expect(result[0].h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove right → left expands to full width", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("A");
      expect(result[0].x).toBeCloseTo(0);
      expect(result[0].w).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  describe("two panes stacked (horizontal split)", () => {
    //  ┌─────────┐
    //  │    A    │
    //  ├─────────┤
    //  │    B    │
    //  └─────────┘
    const panes = () => [p("A", 0, 0, 1, 0.5), p("B", 0, 0.5, 1, 0.5)];

    it("remove top → bottom expands to full height", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("B");
      expect(result[0].y).toBeCloseTo(0);
      expect(result[0].h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove bottom → top expands to full height", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("A");
      expect(result[0].h).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  // === Three panes — L-shape layouts (THE USER'S BUG) ===

  describe("left full-height + right split top/bottom", () => {
    //  ┌────┬────┐
    //  │    │ B  │
    //  │ A  ├────┤
    //  │    │ C  │
    //  └────┴────┘
    const panes = () => [
      p("A", 0, 0, 0.5, 1),
      p("B", 0.5, 0, 0.5, 0.5),
      p("C", 0.5, 0.5, 0.5, 0.5),
    ];

    it("remove top-right (B) → bottom-right (C) expands up", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      const c = result.find((r) => r.id === "C")!;
      // A stays unchanged
      expect(a.x).toBeCloseTo(0);
      expect(a.w).toBeCloseTo(0.5);
      expect(a.h).toBeCloseTo(1);
      // C expands upward to fill B's space
      expect(c.x).toBeCloseTo(0.5);
      expect(c.y).toBeCloseTo(0);
      expect(c.w).toBeCloseTo(0.5);
      expect(c.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove bottom-right (C) → top-right (B) expands down", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      const b = result.find((r) => r.id === "B")!;
      expect(a.h).toBeCloseTo(1);
      expect(b.x).toBeCloseTo(0.5);
      expect(b.y).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(0.5);
      expect(b.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove left (A) → B and C both expand left", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      const c = result.find((r) => r.id === "C")!;
      expect(b.x).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(1);
      expect(b.h).toBeCloseTo(0.5);
      expect(c.x).toBeCloseTo(0);
      expect(c.w).toBeCloseTo(1);
      expect(c.h).toBeCloseTo(0.5);
      validateLayout(result);
    });
  });

  describe("right full-height + left split top/bottom", () => {
    //  ┌────┬────┐
    //  │ A  │    │
    //  ├────┤ C  │
    //  │ B  │    │
    //  └────┴────┘
    const panes = () => [p("A", 0, 0, 0.5, 0.5), p("B", 0, 0.5, 0.5, 0.5), p("C", 0.5, 0, 0.5, 1)];

    it("remove top-left (A) → bottom-left (B) expands up", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      expect(b.x).toBeCloseTo(0);
      expect(b.y).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(0.5);
      expect(b.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove bottom-left (B) → top-left (A) expands down", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      expect(a.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove right (C) → A and B both expand right", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      const b = result.find((r) => r.id === "B")!;
      expect(a.w).toBeCloseTo(1);
      expect(b.w).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  describe("top full-width + bottom split left/right", () => {
    //  ┌──────────┐
    //  │    A     │
    //  ├────┬─────┤
    //  │ B  │  C  │
    //  └────┴─────┘
    const panes = () => [
      p("A", 0, 0, 1, 0.5),
      p("B", 0, 0.5, 0.4, 0.5),
      p("C", 0.4, 0.5, 0.6, 0.5),
    ];

    it("remove bottom-left (B) → bottom-right (C) expands left", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      const c = result.find((r) => r.id === "C")!;
      expect(c.x).toBeCloseTo(0);
      expect(c.w).toBeCloseTo(1);
      expect(c.h).toBeCloseTo(0.5);
      validateLayout(result);
    });

    it("remove bottom-right (C) → bottom-left (B) expands right", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      expect(b.x).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove top (A) → B and C both expand up", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      const c = result.find((r) => r.id === "C")!;
      expect(b.y).toBeCloseTo(0);
      expect(b.h).toBeCloseTo(1);
      expect(c.y).toBeCloseTo(0);
      expect(c.h).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  describe("bottom full-width + top split left/right", () => {
    //  ┌────┬─────┐
    //  │ A  │  B  │
    //  ├────┴─────┤
    //  │    C     │
    //  └──────────┘
    const panes = () => [p("A", 0, 0, 0.5, 0.5), p("B", 0.5, 0, 0.5, 0.5), p("C", 0, 0.5, 1, 0.5)];

    it("remove top-left (A) → top-right (B) expands left", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      expect(b.x).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove top-right (B) → top-left (A) expands right", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      expect(a.w).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove bottom (C) → A and B both expand down", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      const b = result.find((r) => r.id === "B")!;
      expect(a.h).toBeCloseTo(1);
      expect(b.h).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  // === 2x2 grid ===

  describe("2x2 grid", () => {
    //  ┌────┬────┐
    //  │ A  │ B  │
    //  ├────┼────┤
    //  │ C  │ D  │
    //  └────┴────┘
    const panes = () => [
      p("A", 0, 0, 0.5, 0.5),
      p("B", 0.5, 0, 0.5, 0.5),
      p("C", 0, 0.5, 0.5, 0.5),
      p("D", 0.5, 0.5, 0.5, 0.5),
    ];

    it("remove A → valid layout with 3 panes, no overlaps", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "A")).toBeUndefined();
      validateLayout(result);
    });

    it("remove B → valid layout with 3 panes, no overlaps", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "B")).toBeUndefined();
      validateLayout(result);
    });

    it("remove C → valid layout with 3 panes, no overlaps", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "C")).toBeUndefined();
      validateLayout(result);
    });

    it("remove D → valid layout with 3 panes, no overlaps", () => {
      const result = removePaneAndRedistribute(panes(), 3)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "D")).toBeUndefined();
      validateLayout(result);
    });
  });

  // === Three columns ===

  describe("three equal columns", () => {
    //  ┌───┬───┬───┐
    //  │ A │ B │ C │
    //  └───┴───┴───┘
    const panes = () => [
      p("A", 0, 0, 1 / 3, 1),
      p("B", 1 / 3, 0, 1 / 3, 1),
      p("C", 2 / 3, 0, 1 / 3, 1),
    ];

    it("remove middle (B) → one neighbor absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      expect(result.find((r) => r.id === "B")).toBeUndefined();
      validateLayout(result);
    });

    it("remove left (A) → B absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      validateLayout(result);
    });

    it("remove right (C) → B absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      validateLayout(result);
    });
  });

  // === Three rows ===

  describe("three equal rows", () => {
    //  ┌─────────┐
    //  │    A    │
    //  ├─────────┤
    //  │    B    │
    //  ├─────────┤
    //  │    C    │
    //  └─────────┘
    const panes = () => [
      p("A", 0, 0, 1, 1 / 3),
      p("B", 0, 1 / 3, 1, 1 / 3),
      p("C", 0, 2 / 3, 1, 1 / 3),
    ];

    it("remove middle (B) → one neighbor absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      validateLayout(result);
    });
  });

  // === Full-height left + right split into 3 ===

  describe("left full-height + right split into 3 rows", () => {
    //  ┌────┬────┐
    //  │    │ B  │
    //  │    ├────┤
    //  │ A  │ C  │
    //  │    ├────┤
    //  │    │ D  │
    //  └────┴────┘
    const panes = () => [
      p("A", 0, 0, 0.5, 1),
      p("B", 0.5, 0, 0.5, 1 / 3),
      p("C", 0.5, 1 / 3, 0.5, 1 / 3),
      p("D", 0.5, 2 / 3, 0.5, 1 / 3),
    ];

    it("remove middle-right (C) → neighbor in column absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "C")).toBeUndefined();
      // A should be unchanged
      const a = result.find((r) => r.id === "A")!;
      expect(a.w).toBeCloseTo(0.5);
      expect(a.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove top-right (B) → neighbor in column absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "B")).toBeUndefined();
      validateLayout(result);
    });
  });

  // === Asymmetric ratios ===

  describe("asymmetric L-shape (70/30 split)", () => {
    //  ┌──────┬──┐
    //  │      │B │
    //  │  A   ├──┤
    //  │      │C │
    //  └──────┴──┘
    const panes = () => [
      p("A", 0, 0, 0.7, 1),
      p("B", 0.7, 0, 0.3, 0.4),
      p("C", 0.7, 0.4, 0.3, 0.6),
    ];

    it("remove B → C expands up", () => {
      const result = removePaneAndRedistribute(panes(), 1)!;
      expect(result).toHaveLength(2);
      const c = result.find((r) => r.id === "C")!;
      expect(c.y).toBeCloseTo(0);
      expect(c.h).toBeCloseTo(1);
      expect(c.w).toBeCloseTo(0.3);
      validateLayout(result);
    });

    it("remove A → B and C expand left", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(2);
      const b = result.find((r) => r.id === "B")!;
      const c = result.find((r) => r.id === "C")!;
      expect(b.x).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(1);
      expect(c.x).toBeCloseTo(0);
      expect(c.w).toBeCloseTo(1);
      validateLayout(result);
    });
  });

  // === Complex: T-shape ===

  describe("T-shape: top full-width + bottom three columns", () => {
    //  ┌──────────────┐
    //  │      A       │
    //  ├────┬────┬────┤
    //  │ B  │ C  │ D  │
    //  └────┴────┴────┘
    const panes = () => [
      p("A", 0, 0, 1, 0.5),
      p("B", 0, 0.5, 1 / 3, 0.5),
      p("C", 1 / 3, 0.5, 1 / 3, 0.5),
      p("D", 2 / 3, 0.5, 1 / 3, 0.5),
    ];

    it("remove C (bottom-middle) → neighbor in row absorbs", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(3);
      expect(result.find((r) => r.id === "C")).toBeUndefined();
      // A stays unchanged
      const a = result.find((r) => r.id === "A")!;
      expect(a.w).toBeCloseTo(1);
      expect(a.h).toBeCloseTo(0.5);
      validateLayout(result);
    });

    it("remove A (top) → B, C, D all expand up", () => {
      const result = removePaneAndRedistribute(panes(), 0)!;
      expect(result).toHaveLength(3);
      for (const pane of result) {
        expect(pane.y).toBeCloseTo(0);
        expect(pane.h).toBeCloseTo(1);
      }
      validateLayout(result);
    });
  });

  // === Preserves extra properties ===

  it("preserves all properties of non-removed panes (id, etc.)", () => {
    const panes = [
      { id: "keep-me", x: 0, y: 0, w: 0.5, h: 1, extra: "data" },
      { id: "remove-me", x: 0.5, y: 0, w: 0.5, h: 1, extra: "gone" },
    ];
    const result = removePaneAndRedistribute(panes, 1)!;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("keep-me");
    expect((result[0] as any).extra).toBe("data");
  });

  // === Does not mutate input ===

  it("does not mutate the input panes array", () => {
    const panes = [p("A", 0, 0, 0.5, 1), p("B", 0.5, 0, 0.5, 1)];
    const original = JSON.parse(JSON.stringify(panes));
    removePaneAndRedistribute(panes, 0);
    expect(panes).toEqual(original);
  });

  // === Unequal multi-pane absorption on one side ===

  describe("unequal panes absorbing together", () => {
    //  ┌────┬──────┐
    //  │ A  │      │
    //  ├────┤  C   │  remove C → A and B expand right
    //  │ B  │      │
    //  └────┴──────┘
    const panes = () => [p("A", 0, 0, 0.4, 0.6), p("B", 0, 0.6, 0.4, 0.4), p("C", 0.4, 0, 0.6, 1)];

    it("remove C → A and B expand right", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(2);
      const a = result.find((r) => r.id === "A")!;
      const b = result.find((r) => r.id === "B")!;
      expect(a.x).toBeCloseTo(0);
      expect(a.w).toBeCloseTo(1);
      expect(a.h).toBeCloseTo(0.6);
      expect(b.x).toBeCloseTo(0);
      expect(b.w).toBeCloseTo(1);
      expect(b.h).toBeCloseTo(0.4);
      validateLayout(result);
    });
  });

  // === Four panes: 2 left + 2 right with different splits ===

  describe("2 left + 2 right with different horizontal splits", () => {
    //  ┌────┬────┐
    //  │ A  │ C  │   A: h=0.6, C: h=0.3
    //  │    ├────┤
    //  ├────┤ D  │   B: h=0.4, D: h=0.7
    //  │ B  │    │
    //  └────┴────┘
    const panes = () => [
      p("A", 0, 0, 0.5, 0.6),
      p("B", 0, 0.6, 0.5, 0.4),
      p("C", 0.5, 0, 0.5, 0.3),
      p("D", 0.5, 0.3, 0.5, 0.7),
    ];

    it("remove C → D (same column) absorbs C", () => {
      const result = removePaneAndRedistribute(panes(), 2)!;
      expect(result).toHaveLength(3);
      const d = result.find((r) => r.id === "D")!;
      expect(d.x).toBeCloseTo(0.5);
      expect(d.y).toBeCloseTo(0);
      expect(d.w).toBeCloseTo(0.5);
      expect(d.h).toBeCloseTo(1);
      validateLayout(result);
    });

    it("remove D → C (same column) absorbs D", () => {
      const result = removePaneAndRedistribute(panes(), 3)!;
      expect(result).toHaveLength(3);
      const c = result.find((r) => r.id === "C")!;
      expect(c.x).toBeCloseTo(0.5);
      expect(c.y).toBeCloseTo(0);
      expect(c.w).toBeCloseTo(0.5);
      expect(c.h).toBeCloseTo(1);
      validateLayout(result);
    });
  });
});
