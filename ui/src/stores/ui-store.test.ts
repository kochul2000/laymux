import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";
import { useSettingsStore } from "./settings-store";

describe("ui-store", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("starts with settings modal closed", () => {
    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  it("opens settings modal", () => {
    useUiStore.getState().openSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
  });

  it("closes settings modal", () => {
    useUiStore.getState().openSettingsModal();
    useUiStore.getState().closeSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  it("toggles settings modal", () => {
    useUiStore.getState().toggleSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
    useUiStore.getState().toggleSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  it("starts with notification panel closed", () => {
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  it("toggles notification panel", () => {
    useUiStore.getState().toggleNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);
    useUiStore.getState().toggleNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  it("closes notification panel", () => {
    useUiStore.getState().toggleNotificationPanel();
    useUiStore.getState().closeNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  it("opening settings modal closes notification panel", () => {
    useUiStore.getState().toggleNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);
    useUiStore.getState().openSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  it("toggling notification panel open closes settings modal", () => {
    useUiStore.getState().openSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
    useUiStore.getState().toggleNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);
    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  it("toggling settings modal open closes notification panel", () => {
    useUiStore.getState().toggleNotificationPanel();
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);
    useUiStore.getState().toggleSettingsModal();
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  it("starts with app focused", () => {
    expect(useUiStore.getState().isAppFocused).toBe(true);
  });

  it("sets app focused state", () => {
    useUiStore.getState().setAppFocused(false);
    expect(useUiStore.getState().isAppFocused).toBe(false);
    useUiStore.getState().setAppFocused(true);
    expect(useUiStore.getState().isAppFocused).toBe(true);
  });

  // -- hidden-items shelf --

  it("starts with the hidden-items shelf closed", () => {
    expect(useUiStore.getState().hiddenShelfOpen).toBe(false);
  });

  it("sets the hidden-items shelf deterministically", () => {
    useUiStore.getState().setHiddenShelfOpen(true);
    useUiStore.getState().setHiddenShelfOpen(true);
    expect(useUiStore.getState().hiddenShelfOpen).toBe(true);
    useUiStore.getState().setHiddenShelfOpen(false);
    expect(useUiStore.getState().hiddenShelfOpen).toBe(false);
  });

  // -- hidden pane ids --

  it("starts with no hidden panes", () => {
    expect(useUiStore.getState().hiddenPaneIds.size).toBe(0);
  });

  it("toggles pane hidden state", () => {
    useUiStore.getState().togglePaneHidden("pane-1");
    expect(useUiStore.getState().hiddenPaneIds.has("pane-1")).toBe(true);
    useUiStore.getState().togglePaneHidden("pane-1");
    expect(useUiStore.getState().hiddenPaneIds.has("pane-1")).toBe(false);
  });

  it("can hide multiple panes", () => {
    useUiStore.getState().togglePaneHidden("pane-1");
    useUiStore.getState().togglePaneHidden("pane-2");
    expect(useUiStore.getState().hiddenPaneIds.size).toBe(2);
    expect(useUiStore.getState().hiddenPaneIds.has("pane-1")).toBe(true);
    expect(useUiStore.getState().hiddenPaneIds.has("pane-2")).toBe(true);
  });

  it("setPaneHidden is idempotent and unhide clears eviction immediately", () => {
    useUiStore.getState().setPaneHidden("pane-1", true);
    const hiddenRef = useUiStore.getState().hiddenPaneIds;
    useUiStore.getState().setPaneHidden("pane-1", true);
    expect(useUiStore.getState().hiddenPaneIds).toBe(hiddenRef);

    useUiStore.getState().setEvictedPaneIds(new Set(["pane-1", "pane-2"]));
    useUiStore.getState().setPaneHidden("pane-1", false);
    expect(useUiStore.getState().hiddenPaneIds.has("pane-1")).toBe(false);
    expect(useUiStore.getState().evictedPaneIds).toEqual(new Set(["pane-2"]));
  });

  it("persists explicit pane hidden transitions to the existing localStorage key", () => {
    useUiStore.getState().setPaneHidden("pane-1", true);
    expect(JSON.parse(localStorage.getItem("laymux-hidden-panes") ?? "null")).toEqual(["pane-1"]);

    useUiStore.getState().setPaneHidden("pane-1", false);
    expect(JSON.parse(localStorage.getItem("laymux-hidden-panes") ?? "null")).toEqual([]);
  });

  it("closes the shelf when the last pane is restored", () => {
    useUiStore.getState().setPaneHidden("pane-1", true);
    useUiStore.getState().setHiddenShelfOpen(true);
    useUiStore.getState().setPaneHidden("pane-1", false);
    expect(useUiStore.getState().hiddenShelfOpen).toBe(false);
  });

  // -- hidden workspace ids --

  it("starts with no hidden workspaces", () => {
    expect(useUiStore.getState().hiddenWorkspaceIds.size).toBe(0);
  });

  it("toggles workspace hidden state", () => {
    useUiStore.getState().toggleWorkspaceHidden("ws-1");
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-1")).toBe(true);
    useUiStore.getState().toggleWorkspaceHidden("ws-1");
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-1")).toBe(false);
  });

  it("can hide multiple workspaces", () => {
    useUiStore.getState().toggleWorkspaceHidden("ws-1");
    useUiStore.getState().toggleWorkspaceHidden("ws-2");
    expect(useUiStore.getState().hiddenWorkspaceIds.size).toBe(2);
  });

  it("setWorkspaceHidden is idempotent and restoring clears child evictions", () => {
    useUiStore.getState().setWorkspaceHidden("ws-1", true, ["pane-1", "pane-2"]);
    const hiddenRef = useUiStore.getState().hiddenWorkspaceIds;
    useUiStore.getState().setWorkspaceHidden("ws-1", true, ["pane-1", "pane-2"]);
    expect(useUiStore.getState().hiddenWorkspaceIds).toBe(hiddenRef);

    useUiStore.getState().setEvictedPaneIds(new Set(["pane-1", "pane-2", "pane-3"]));
    useUiStore.getState().setWorkspaceHidden("ws-1", false, ["pane-1", "pane-2"]);
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-1")).toBe(false);
    expect(useUiStore.getState().evictedPaneIds).toEqual(new Set(["pane-3"]));
  });

  it("persists explicit workspace hidden transitions to the existing localStorage key", () => {
    useUiStore.getState().setWorkspaceHidden("ws-1", true);
    expect(JSON.parse(localStorage.getItem("laymux-hidden-workspaces") ?? "null")).toEqual([
      "ws-1",
    ]);

    useUiStore.getState().setWorkspaceHidden("ws-1", false);
    expect(JSON.parse(localStorage.getItem("laymux-hidden-workspaces") ?? "null")).toEqual([]);
  });

  it("closes the shelf when the last workspace is restored", () => {
    useUiStore.getState().setWorkspaceHidden("ws-1", true);
    useUiStore.getState().setHiddenShelfOpen(true);
    useUiStore.getState().setWorkspaceHidden("ws-1", false);
    expect(useUiStore.getState().hiddenShelfOpen).toBe(false);
  });

  it("restoreAllHidden clears both hidden sets and evictions atomically", () => {
    useUiStore.getState().setWorkspaceHidden("ws-1", true);
    useUiStore.getState().setPaneHidden("pane-1", true);
    useUiStore.getState().setEvictedPaneIds(new Set(["pane-1"]));

    useUiStore.getState().restoreAllHidden();

    expect(useUiStore.getState()).toMatchObject({ hiddenShelfOpen: false });
    expect(useUiStore.getState().hiddenWorkspaceIds.size).toBe(0);
    expect(useUiStore.getState().hiddenPaneIds.size).toBe(0);
    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });

  it("pruneHiddenIds removes stale persisted IDs and evictions", () => {
    useUiStore.getState().setWorkspaceHidden("ws-valid", true);
    useUiStore.getState().setWorkspaceHidden("ws-stale", true);
    useUiStore.getState().setPaneHidden("pane-valid", true);
    useUiStore.getState().setPaneHidden("pane-stale", true);
    useUiStore.getState().setEvictedPaneIds(new Set(["pane-valid", "pane-stale"]));

    useUiStore.getState().pruneHiddenIds(new Set(["ws-valid"]), new Set(["pane-valid"]));

    expect(useUiStore.getState().hiddenWorkspaceIds).toEqual(new Set(["ws-valid"]));
    expect(useUiStore.getState().hiddenPaneIds).toEqual(new Set(["pane-valid"]));
    expect(useUiStore.getState().evictedPaneIds).toEqual(new Set(["pane-valid"]));
    expect(JSON.parse(localStorage.getItem("laymux-hidden-workspaces") ?? "null")).toEqual([
      "ws-valid",
    ]);
    expect(JSON.parse(localStorage.getItem("laymux-hidden-panes") ?? "null")).toEqual([
      "pane-valid",
    ]);
  });

  // -- evicted (auto-closed) pane ids (issue #269) --

  it("starts with no evicted panes", () => {
    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });

  it("setEvictedPaneIds replaces the evicted set", () => {
    useUiStore.getState().setEvictedPaneIds(new Set(["p1", "p2"]));
    expect(useUiStore.getState().evictedPaneIds.size).toBe(2);
    expect(useUiStore.getState().evictedPaneIds.has("p1")).toBe(true);
    useUiStore.getState().setEvictedPaneIds(new Set(["p3"]));
    expect(useUiStore.getState().evictedPaneIds.has("p1")).toBe(false);
    expect(useUiStore.getState().evictedPaneIds.has("p3")).toBe(true);
  });

  it("setEvictedPaneIds keeps the same reference when the set is unchanged", () => {
    useUiStore.getState().setEvictedPaneIds(new Set(["p1"]));
    const ref = useUiStore.getState().evictedPaneIds;
    useUiStore.getState().setEvictedPaneIds(new Set(["p1"]));
    expect(useUiStore.getState().evictedPaneIds).toBe(ref);
  });

  // -- duplicate-aware hidden propagation --

  describe("propagateHiddenOnDuplicate", () => {
    it("propagates workspace hidden flag to the new duplicate", () => {
      useUiStore.getState().toggleWorkspaceHidden("ws-src");
      useUiStore.getState().propagateHiddenOnDuplicate("ws-src", "ws-dup", {});
      expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-dup")).toBe(true);
      // Source remains hidden.
      expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-src")).toBe(true);
    });

    it("does not add a workspace hidden flag when source is visible", () => {
      useUiStore.getState().propagateHiddenOnDuplicate("ws-src", "ws-dup", {});
      expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-dup")).toBe(false);
    });

    it("does not hide a duplicate that will immediately become active", () => {
      useUiStore.getState().setWorkspaceHidden("ws-src", true);
      useUiStore.getState().propagateHiddenOnDuplicate("ws-src", "ws-dup", {}, true);
      expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-src")).toBe(true);
      expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-dup")).toBe(false);
    });

    it("maps hidden source panes to their new pane IDs", () => {
      useUiStore.getState().togglePaneHidden("pane-a");
      useUiStore.getState().togglePaneHidden("pane-b"); // also hidden, gets mapped
      useUiStore.getState().propagateHiddenOnDuplicate("ws-src", "ws-dup", {
        "pane-a": "pane-a-new",
        "pane-b": "pane-b-new",
        "pane-c": "pane-c-new", // visible source → no entry added
      });
      const hidden = useUiStore.getState().hiddenPaneIds;
      expect(hidden.has("pane-a-new")).toBe(true);
      expect(hidden.has("pane-b-new")).toBe(true);
      expect(hidden.has("pane-c-new")).toBe(false);
      // Source pane ids remain hidden.
      expect(hidden.has("pane-a")).toBe(true);
      expect(hidden.has("pane-b")).toBe(true);
    });

    it("is a no-op when neither source workspace nor panes are hidden", () => {
      useUiStore
        .getState()
        .propagateHiddenOnDuplicate("ws-src", "ws-dup", { "pane-a": "pane-a-new" });
      expect(useUiStore.getState().hiddenWorkspaceIds.size).toBe(0);
      expect(useUiStore.getState().hiddenPaneIds.size).toBe(0);
    });
  });
});
