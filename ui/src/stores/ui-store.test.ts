import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";

describe("ui-store", () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState());
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
});
