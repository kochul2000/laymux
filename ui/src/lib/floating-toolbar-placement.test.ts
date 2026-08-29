import { describe, expect, it } from "vitest";
import { resolveFloatingToolbarPlacement } from "./floating-toolbar-placement";

const viewport = { width: 900, height: 700 };

describe("resolveFloatingToolbarPlacement", () => {
  it("prefers the row immediately below the anchor when it fits inside the pane", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 40, right: 480, bottom: 62, left: 458 },
        pane: { top: 40, right: 500, bottom: 400, left: 100 },
        menu: { width: 320, height: 54 },
        viewport,
      }),
    ).toMatchObject({ placement: "down", top: 64, left: 160, constrained: false });
  });

  it("flips above the anchor before escaping a short pane downward", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 510, right: 780, bottom: 532, left: 758 },
        pane: { top: 500, right: 800, bottom: 560, left: 500 },
        menu: { width: 260, height: 96 },
        viewport,
      }),
    ).toMatchObject({ placement: "up", top: 412, left: 520, constrained: false });
  });

  it("may escape the pane downward when neither pane-down nor viewport-up can fit", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 20, right: 260, bottom: 42, left: 238 },
        pane: { top: 20, right: 280, bottom: 70, left: 20 },
        menu: { width: 240, height: 120 },
        viewport,
      }),
    ).toMatchObject({ placement: "down", top: 44, left: 20, escapedPane: true });
  });

  it("clamps an edge-aligned menu to the viewport on both horizontal sides", () => {
    const right = resolveFloatingToolbarPlacement({
      anchor: { top: 40, right: 895, bottom: 62, left: 873 },
      pane: { top: 40, right: 900, bottom: 400, left: 600 },
      menu: { width: 340, height: 54 },
      viewport,
    });
    const left = resolveFloatingToolbarPlacement({
      anchor: { top: 40, right: 30, bottom: 62, left: 8 },
      pane: { top: 40, right: 300, bottom: 400, left: 0 },
      menu: { width: 340, height: 54 },
      viewport,
    });

    expect(right.left).toBe(552);
    expect(left.left).toBe(8);
    expect(right.maxWidth).toBe(340);
  });

  it("keeps a wrapped toolbar capped to the pane width", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 40, right: 500, bottom: 62, left: 478 },
        pane: { top: 40, right: 500, bottom: 400, left: 240 },
        menu: { width: 260, height: 80 },
        viewport,
      }),
    ).toMatchObject({ maxWidth: 260, left: 240 });
  });

  it("lets an intrinsically wider control escape a tiny pane without taking the viewport width", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 40, right: 60, bottom: 62, left: 38 },
        pane: { top: 40, right: 60, bottom: 400, left: 20 },
        menu: { width: 110, height: 80 },
        viewport: { width: 300, height: 700 },
      }),
    ).toMatchObject({ maxWidth: 110, left: 8 });
  });

  it("uses the larger viewport side and exposes a max height when no side can show it whole", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: 240, right: 500, bottom: 262, left: 478 },
        pane: { top: 220, right: 520, bottom: 300, left: 200 },
        menu: { width: 300, height: 600 },
        viewport: { width: 900, height: 500 },
      }),
    ).toMatchObject({
      placement: "up",
      top: 8,
      maxHeight: 230,
      constrained: true,
      escapedPane: true,
    });
  });

  it("still exposes a viewport-sized scrolling surface when the anchor leaves no directional room", () => {
    expect(
      resolveFloatingToolbarPlacement({
        anchor: { top: -10, right: 50, bottom: 90, left: 0 },
        pane: { top: -10, right: 50, bottom: 90, left: 0 },
        menu: { width: 400, height: 500 },
        viewport: { width: 60, height: 80 },
      }),
    ).toMatchObject({
      top: 8,
      left: 8,
      maxWidth: 44,
      maxHeight: 64,
      constrained: true,
      constrainedX: true,
    });
  });
});
