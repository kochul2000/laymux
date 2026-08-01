import { describe, expect, it } from "vitest";
import {
  addWidget,
  allPlacements,
  defaultWidgets,
  fitWidgets,
  moveWidget,
  normalizeWidgets,
  nudgeWidget,
  removeWidget,
  updateWidgetOptions,
  type WidgetInstance,
} from "./widget-placement";

const instance = (id: string, type = "cwd"): WidgetInstance => ({ id, type, options: {} });

describe("normalizeWidgets", () => {
  it("starts empty with the status line off", () => {
    const widgets = normalizeWidgets(undefined);
    expect(widgets).toEqual(defaultWidgets());
  });

  it("keeps an unknown type so another version's placement is not destroyed", () => {
    const widgets = normalizeWidgets({
      topBar: { left: [{ id: "w1", type: "fromTheFuture" }] },
    });
    expect(widgets.topBar.left).toEqual([{ id: "w1", type: "fromTheFuture", options: {} }]);
  });

  it("drops entries that carry no placement at all", () => {
    const widgets = normalizeWidgets({
      topBar: { left: [{ type: "cwd" }, { id: "" }, null, "cwd", { id: "w1", type: "cwd" }] },
    });
    expect(widgets.topBar.left.map((w) => w.id)).toEqual(["w1"]);
  });

  it("drops a duplicate id across slots so identity stays unambiguous", () => {
    const widgets = normalizeWidgets({
      topBar: { left: [{ id: "dup", type: "cwd" }] },
      statusLine: { enabled: true, right: [{ id: "dup", type: "notifications" }] },
    });
    expect(widgets.topBar.left).toHaveLength(1);
    expect(widgets.statusLine.right).toHaveLength(0);
    expect(widgets.statusLine.enabled).toBe(true);
  });

  it("coerces a non-array slot and a non-object options", () => {
    const widgets = normalizeWidgets({
      topBar: { left: "nope", right: [{ id: "w1", type: "cwd", options: 7 }] },
    });
    expect(widgets.topBar.left).toEqual([]);
    expect(widgets.topBar.right[0].options).toEqual({});
  });
});

describe("placement transforms", () => {
  const base = addWidget(
    addWidget(defaultWidgets(), { surface: "topBar", side: "left" }, instance("a")),
    { surface: "topBar", side: "left" },
    instance("b"),
  );

  it("moves an instance between surfaces keeping its id and options", () => {
    const withOptions = updateWidgetOptions(base, "a", { display: "bar" });
    const moved = moveWidget(withOptions, "a", { surface: "statusLine", side: "right" }, 0);

    expect(moved.topBar.left.map((w) => w.id)).toEqual(["b"]);
    expect(moved.statusLine.right).toEqual([{ id: "a", type: "cwd", options: { display: "bar" } }]);
  });

  it("reorders within a slot against the post-removal index", () => {
    const moved = moveWidget(base, "a", { surface: "topBar", side: "left" }, 1);
    expect(moved.topBar.left.map((w) => w.id)).toEqual(["b", "a"]);
  });

  it("clamps an out-of-range target index", () => {
    const moved = moveWidget(base, "a", { surface: "topBar", side: "left" }, 99);
    expect(moved.topBar.left.map((w) => w.id)).toEqual(["b", "a"]);
  });

  it("nudges within the slot and stops at the ends", () => {
    expect(nudgeWidget(base, "a", 1).topBar.left.map((w) => w.id)).toEqual(["b", "a"]);
    expect(nudgeWidget(base, "a", -1)).toBe(base);
    expect(nudgeWidget(base, "missing", 1)).toBe(base);
  });

  it("removes by id from whichever slot holds it", () => {
    const moved = moveWidget(base, "b", { surface: "statusLine", side: "left" }, 0);
    const removed = removeWidget(moved, "b");
    expect(allPlacements(removed).map((p) => p.instance.id)).toEqual(["a"]);
  });

  it("merges option patches instead of replacing the object", () => {
    const once = updateWidgetOptions(base, "a", { display: "bar" });
    const twice = updateWidgetOptions(once, "a", { configDir: "/tmp" });
    expect(twice.topBar.left[0].options).toEqual({ display: "bar", configDir: "/tmp" });
  });
});

describe("fitWidgets", () => {
  const candidates = [
    { id: "a", minWidth: 40 },
    { id: "b", minWidth: 40 },
    { id: "c", minWidth: 40 },
  ];

  it("keeps everything when the budget is enough", () => {
    expect(fitWidgets(candidates, 120, "left", 16)).toEqual({
      visible: ["a", "b", "c"],
      collapsed: [],
    });
  });

  it("sheds from the tail in a left slot so the window edge keeps its widgets", () => {
    expect(fitWidgets(candidates, 90, "left", 16)).toEqual({
      visible: ["a"],
      collapsed: ["b", "c"],
    });
  });

  it("sheds from the head in a right slot", () => {
    expect(fitWidgets(candidates, 90, "right", 16)).toEqual({
      visible: ["c"],
      collapsed: ["a", "b"],
    });
  });

  it("preserves the user's order in the visible list regardless of shed side", () => {
    const result = fitWidgets(candidates, 116, "right", 16);
    expect(result.visible).toEqual(["b", "c"]);
  });

  it("collapses everything when nothing fits", () => {
    expect(fitWidgets(candidates, 10, "left", 16).visible).toEqual([]);
  });

  it("lets the last widget use the space the indicator would have taken", () => {
    // 40 + 40 = 80 fits exactly only because no indicator is needed once
    // nothing is left to collapse.
    expect(fitWidgets(candidates.slice(0, 2), 80, "left", 16).visible).toEqual(["a", "b"]);
  });
});
