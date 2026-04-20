import { describe, it, expect, beforeEach } from "vitest";
import { useOverridesStore, PANE_OVERRIDES_KEY, VIEW_OVERRIDES_KEY } from "./overrides-store";

describe("overrides-store", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store from a clean localStorage so initial state is empty.
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
  });

  // -- pane overrides --

  it("getPaneOverride returns undefined for unknown paneId", () => {
    expect(useOverridesStore.getState().getPaneOverride("pane-unknown")).toBeUndefined();
  });

  it("setPaneOverride stores patch and getPaneOverride returns it", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    expect(useOverridesStore.getState().getPaneOverride("pane-1")).toEqual({
      controlBarMode: "pinned",
    });
  });

  it("setPaneOverride merges patches on the same paneId", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "minimized" });
    expect(useOverridesStore.getState().getPaneOverride("pane-1")).toEqual({
      controlBarMode: "minimized",
    });
  });

  it("clearPaneOverride removes the entry", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().clearPaneOverride("pane-1");
    expect(useOverridesStore.getState().getPaneOverride("pane-1")).toBeUndefined();
  });

  // -- view overrides --

  it("getViewOverride returns undefined for unknown paneId", () => {
    expect(useOverridesStore.getState().getViewOverride("pane-unknown")).toBeUndefined();
  });

  it("setViewOverride stores patch and getViewOverride returns it", () => {
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    expect(useOverridesStore.getState().getViewOverride("pane-1")).toEqual({ fontSize: 17 });
  });

  it("setViewOverride merges patches on the same paneId", () => {
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 20 });
    expect(useOverridesStore.getState().getViewOverride("pane-1")).toEqual({ fontSize: 20 });
  });

  it("clearViewOverride removes the view entry but preserves pane overrides", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    useOverridesStore.getState().clearViewOverride("pane-1");
    expect(useOverridesStore.getState().getViewOverride("pane-1")).toBeUndefined();
    expect(useOverridesStore.getState().getPaneOverride("pane-1")).toEqual({
      controlBarMode: "pinned",
    });
  });

  // -- clearAll (pane deletion hook) --

  it("clearAll removes both pane and view overrides for the paneId", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    useOverridesStore.getState().clearAll("pane-1");
    expect(useOverridesStore.getState().getPaneOverride("pane-1")).toBeUndefined();
    expect(useOverridesStore.getState().getViewOverride("pane-1")).toBeUndefined();
  });

  it("clearAll leaves other panes untouched", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("pane-2", { fontSize: 20 });
    useOverridesStore.getState().clearAll("pane-1");
    expect(useOverridesStore.getState().getViewOverride("pane-2")).toEqual({ fontSize: 20 });
  });

  // -- gcStale (defensive cleanup on session load) --

  it("gcStale keeps overrides whose paneId is in aliveSet, removes others", () => {
    useOverridesStore.getState().setPaneOverride("pane-alive", { controlBarMode: "pinned" });
    useOverridesStore.getState().setPaneOverride("pane-dead", { controlBarMode: "minimized" });
    useOverridesStore.getState().setViewOverride("pane-alive", { fontSize: 17 });
    useOverridesStore.getState().setViewOverride("pane-dead", { fontSize: 20 });

    useOverridesStore.getState().gcStale(new Set(["pane-alive"]));

    expect(useOverridesStore.getState().getPaneOverride("pane-alive")).toEqual({
      controlBarMode: "pinned",
    });
    expect(useOverridesStore.getState().getViewOverride("pane-alive")).toEqual({ fontSize: 17 });
    expect(useOverridesStore.getState().getPaneOverride("pane-dead")).toBeUndefined();
    expect(useOverridesStore.getState().getViewOverride("pane-dead")).toBeUndefined();
  });

  // -- localStorage persistence --

  it("setPaneOverride persists to localStorage", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    const raw = localStorage.getItem(PANE_OVERRIDES_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ "pane-1": { controlBarMode: "pinned" } });
  });

  it("setViewOverride persists to localStorage", () => {
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    const raw = localStorage.getItem(VIEW_OVERRIDES_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ "pane-1": { fontSize: 17 } });
  });

  it("clearAll persists the cleared state to localStorage", () => {
    useOverridesStore.getState().setPaneOverride("pane-1", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("pane-1", { fontSize: 17 });
    useOverridesStore.getState().clearAll("pane-1");
    expect(JSON.parse(localStorage.getItem(PANE_OVERRIDES_KEY) ?? "{}")).toEqual({});
    expect(JSON.parse(localStorage.getItem(VIEW_OVERRIDES_KEY) ?? "{}")).toEqual({});
  });
});
