import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";
import { useSettingsStore } from "./settings-store";

describe("ui-store", () => {
  beforeEach(() => {
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

  // -- barModes --

  it("setBarMode persists mode and getBarMode retrieves it", () => {
    useUiStore.getState().setBarMode("pane-1", "pinned");
    expect(useUiStore.getState().barModes["pane-1"]).toBe("pinned");
    expect(useUiStore.getState().getBarMode("pane-1")).toBe("pinned");
  });

  it("getBarMode returns settings default when no persisted mode", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "minimized" },
    }));
    expect(useUiStore.getState().getBarMode("pane-unknown")).toBe("minimized");
  });

  it("getBarMode returns hover when settings default is hover", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "hover" },
    }));
    expect(useUiStore.getState().getBarMode("pane-unknown")).toBe("hover");
  });

  it("persisted mode overrides settings default", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "minimized" },
    }));
    useUiStore.getState().setBarMode("pane-1", "pinned");
    expect(useUiStore.getState().getBarMode("pane-1")).toBe("pinned");
  });
});
