import { describe, expect, it } from "vitest";
import {
  COLUMNS_MIN_ASPECT,
  COLUMN_MIN_WIDTH,
  COMPACT_MAX_HEIGHT,
  USAGE_ROW_COUNT,
  resolveUsageLayout,
  showsDetail,
} from "./usage-layout";

describe("resolveUsageLayout", () => {
  it("stacks a tall pane", () => {
    expect(resolveUsageLayout({ width: 320, height: 640 })).toBe("stacked");
  });

  it("stacks a roughly square pane", () => {
    expect(resolveUsageLayout({ width: 400, height: 400 })).toBe("stacked");
  });

  it("uses columns for a wide short pane", () => {
    expect(resolveUsageLayout({ width: 900, height: 300 })).toBe("columns");
  });

  it("stacks a wide pane that is too narrow for real columns", () => {
    // Wide by ratio but not by pixels: three columns would be unreadable.
    const width = COLUMN_MIN_WIDTH * USAGE_ROW_COUNT - 1;
    const height = Math.ceil(width / COLUMNS_MIN_ASPECT);
    expect(resolveUsageLayout({ width, height })).toBe("stacked");
  });

  it("goes compact for a thin horizontal strip", () => {
    expect(resolveUsageLayout({ width: 1200, height: COMPACT_MAX_HEIGHT - 1 })).toBe("compact");
  });

  it("goes compact for a short narrow box too", () => {
    // Nothing else fits; compact is the only honest rendering.
    expect(resolveUsageLayout({ width: 200, height: 60 })).toBe("compact");
  });

  it("stacks an unmeasured box", () => {
    expect(resolveUsageLayout({ width: 0, height: 0 })).toBe("stacked");
    expect(resolveUsageLayout({ width: 500, height: 0 })).toBe("stacked");
  });

  it("honors a pinned preference over the box", () => {
    expect(resolveUsageLayout({ width: 320, height: 640 }, "columns")).toBe("columns");
    expect(resolveUsageLayout({ width: 1200, height: 200 }, "stacked")).toBe("stacked");
    expect(resolveUsageLayout({ width: 800, height: 600 }, "compact")).toBe("compact");
  });

  it("re-derives from the box when the preference is auto", () => {
    expect(resolveUsageLayout({ width: 900, height: 300 }, "auto")).toBe("columns");
  });

  it("switches arrangement as a pane is resized across the threshold", () => {
    const tall = resolveUsageLayout({ width: 600, height: 600 });
    const wide = resolveUsageLayout({ width: 600, height: 300 });
    expect(tall).toBe("stacked");
    expect(wide).toBe("columns");
  });
});

describe("showsDetail", () => {
  it("hides detail only in compact", () => {
    expect(showsDetail("stacked")).toBe(true);
    expect(showsDetail("columns")).toBe(true);
    expect(showsDetail("compact")).toBe(false);
  });
});
