import { describe, expect, it } from "vitest";
import type { WorkspacePane } from "@/stores/types";
import {
  activeLayer,
  activeLayerIndex,
  allLayerIds,
  cycleActiveLayer,
  dedupeLayerIds,
  findLayerEntry,
  findSlotIndex,
  insertLayer,
  isStacked,
  layerEntries,
  layoutPaneLayers,
  makeLayoutPane,
  makeSlot,
  moveLayerWithin,
  normalizeWorkspacePane,
  removeLayer,
  setActiveLayer,
  toPersistedPane,
  updateLayerView,
} from "./pane-layers";

const rect = { x: 0, y: 0, w: 1, h: 1 };
const term = { type: "TerminalView" as const, profile: "WSL" };
const memo = { type: "MemoView" as const };
const empty = { type: "EmptyView" as const };

function stack3(): WorkspacePane {
  return {
    id: "slot",
    ...rect,
    layers: [
      { id: "a", view: term },
      { id: "b", view: memo },
      { id: "c", view: empty },
    ],
    activeLayerId: "b",
  };
}

describe("pane-layers", () => {
  it("makeSlot gives the single layer the slot id", () => {
    const slot = makeSlot("p1", rect, term);
    expect(slot.layers).toEqual([{ id: "p1", view: term }]);
    expect(slot.activeLayerId).toBe("p1");
    expect(isStacked(slot)).toBe(false);
  });

  it("activeLayer falls back to the first layer when activeLayerId is stale", () => {
    const slot = { ...stack3(), activeLayerId: "gone" };
    expect(activeLayerIndex(slot)).toBe(0);
    expect(activeLayer(slot).id).toBe("a");
  });

  it("layerEntries flattens slots in slot order then stack order", () => {
    const panes = [makeSlot("p0", rect, memo), stack3()];
    const entries = layerEntries(panes);
    expect(entries.map((e) => [e.slotIndex, e.layer.id, e.layerIndex, e.active])).toEqual([
      [0, "p0", 0, true],
      [1, "a", 0, false],
      [1, "b", 1, true],
      [1, "c", 2, false],
    ]);
    expect(allLayerIds(panes)).toEqual(["p0", "a", "b", "c"]);
    expect(findLayerEntry(panes, "c")?.slotIndex).toBe(1);
    expect(findLayerEntry(panes, "zz")).toBeNull();
  });

  it("findSlotIndex resolves slot ids and layer ids", () => {
    const panes = [makeSlot("p0", rect, memo), stack3()];
    expect(findSlotIndex(panes, "slot")).toBe(1);
    expect(findSlotIndex(panes, "c")).toBe(1);
    expect(findSlotIndex(panes, "p0")).toBe(0);
    expect(findSlotIndex(panes, "nope")).toBe(-1);
  });

  it("insertLayer goes after the active layer and activates it by default", () => {
    const next = insertLayer(stack3(), { id: "n", view: empty });
    expect(next.layers.map((l) => l.id)).toEqual(["a", "b", "n", "c"]);
    expect(next.activeLayerId).toBe("n");
    const atEnd = insertLayer(stack3(), { id: "n", view: empty }, { index: 99, activate: false });
    expect(atEnd.layers.map((l) => l.id)).toEqual(["a", "b", "c", "n"]);
    expect(atEnd.activeLayerId).toBe("b");
  });

  it("removeLayer activates the next layer, or the previous when the last is removed", () => {
    expect(removeLayer(stack3(), "b")?.activeLayerId).toBe("c");
    const lastActive = { ...stack3(), activeLayerId: "c" };
    expect(removeLayer(lastActive, "c")?.activeLayerId).toBe("b");
    expect(removeLayer(stack3(), "a")?.activeLayerId).toBe("b");
    expect(removeLayer(makeSlot("p", rect, term), "p")).toBeNull();
    const unchanged = stack3();
    expect(removeLayer(unchanged, "zz")).toBe(unchanged);
  });

  it("setActiveLayer ignores unknown ids and no-op changes", () => {
    const slot = stack3();
    expect(setActiveLayer(slot, "b")).toBe(slot);
    expect(setActiveLayer(slot, "zz")).toBe(slot);
    expect(setActiveLayer(slot, "a").activeLayerId).toBe("a");
  });

  it("cycleActiveLayer wraps around the ring", () => {
    expect(cycleActiveLayer(stack3(), 1).activeLayerId).toBe("c");
    expect(cycleActiveLayer(stack3(), 2).activeLayerId).toBe("a");
    expect(cycleActiveLayer(stack3(), -2).activeLayerId).toBe("c");
    const single = makeSlot("p", rect, term);
    expect(cycleActiveLayer(single, 1)).toBe(single);
  });

  it("updateLayerView replaces one layer's view", () => {
    const next = updateLayerView(stack3(), "c", term);
    expect(next.layers[2].view).toBe(term);
    expect(next.layers[0].view).toBe(term);
    expect(next.layers[1].view).toBe(memo);
  });

  it("moveLayerWithin reorders without changing the active layer", () => {
    const next = moveLayerWithin(stack3(), "a", 2);
    expect(next.layers.map((l) => l.id)).toEqual(["b", "c", "a"]);
    expect(next.activeLayerId).toBe("b");
    const slot = stack3();
    expect(moveLayerWithin(slot, "a", 0)).toBe(slot);
  });

  describe("persistence", () => {
    it("writes single same-id slots in the legacy compact form", () => {
      expect(toPersistedPane(makeSlot("p", rect, term))).toEqual({ id: "p", ...rect, view: term });
    });

    it("writes stacks and id-diverged singles in the layers form", () => {
      expect(toPersistedPane(stack3())).toEqual({
        id: "slot",
        ...rect,
        layers: stack3().layers,
        activeLayerId: "b",
      });
      const diverged: WorkspacePane = {
        id: "slot",
        ...rect,
        layers: [{ id: "x", view: term }],
        activeLayerId: "x",
      };
      expect(toPersistedPane(diverged).layers).toEqual([{ id: "x", view: term }]);
    });

    it("applies mapView to every layer", () => {
      const out = toPersistedPane(stack3(), (view) => ({ ...view, mapped: true }));
      expect(out.layers?.every((layer) => layer.view.mapped === true)).toBe(true);
    });

    it("normalizes both on-disk forms and repairs stale active ids", () => {
      let n = 0;
      const newId = () => `gen-${++n}`;
      expect(normalizeWorkspacePane({ id: "p", ...rect, view: term }, newId)).toEqual(
        makeSlot("p", rect, term),
      );
      const stacked = normalizeWorkspacePane(
        {
          id: "s",
          ...rect,
          layers: [
            { id: "", view: memo },
            { id: "k", view: term },
          ],
          activeLayerId: "zz",
        },
        newId,
      );
      expect(stacked?.layers.map((l) => l.id)).toEqual(["gen-1", "k"]);
      expect(stacked?.activeLayerId).toBe("gen-1");
      expect(normalizeWorkspacePane({ id: "p", ...rect }, newId)).toBeNull();
    });

    it("round-trips a stack", () => {
      const slot = stack3();
      expect(normalizeWorkspacePane(toPersistedPane(slot), () => "x")).toEqual(slot);
    });
  });

  describe("layout templates", () => {
    it("reads compact and stacked template slots", () => {
      expect(layoutPaneLayers({ ...rect, viewType: "MemoView" })).toEqual({
        layers: [{ viewType: "MemoView", viewConfig: undefined }],
        activeIndex: 0,
      });
      const stacked = makeLayoutPane(
        rect,
        [{ viewType: "TerminalView" }, { viewType: "MemoView" }],
        1,
      );
      expect(stacked.viewType).toBe("MemoView");
      expect(stacked.activeLayerIndex).toBe(1);
      expect(layoutPaneLayers(stacked).activeIndex).toBe(1);
      expect(layoutPaneLayers({ ...stacked, activeLayerIndex: 9 }).activeIndex).toBe(0);
    });

    it("keeps single-layer templates compact", () => {
      expect(makeLayoutPane(rect, [{ viewType: "MemoView" }], 0)).toEqual({
        ...rect,
        viewType: "MemoView",
      });
    });
  });
});

describe("dedupeLayerIds (ADR-0295)", () => {
  it("re-mints stacked layer ids already used elsewhere and fixes the active id", () => {
    const seen = new Set(["x"]);
    let n = 0;
    const slot = {
      id: "s",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      layers: [
        { id: "s", view: { type: "MemoView" as const } },
        { id: "x", view: { type: "MemoView" as const } },
      ],
      activeLayerId: "x",
    };
    const out = dedupeLayerIds(slot, seen, () => `new-${++n}`);
    expect(out.layers.map((l) => l.id)).toEqual(["s", "new-1"]);
    expect(out.activeLayerId).toBe("new-1");
    expect([...seen].sort()).toEqual(["new-1", "s", "x"]);
  });

  it("keeps a slot whose ids are fresh untouched", () => {
    const slot = makeSlot("p", { x: 0, y: 0, w: 1, h: 1 }, { type: "MemoView" });
    expect(dedupeLayerIds(slot, new Set(), () => "never")).toBe(slot);
  });
});
