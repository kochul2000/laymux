import { describe, it, expect, beforeEach } from "vitest";
import { useGridStore } from "./grid-store";

describe("grid-store", () => {
  beforeEach(() => {
    useGridStore.setState(useGridStore.getInitialState());
  });

  it("starts with edit mode off", () => {
    expect(useGridStore.getState().editMode).toBe(false);
  });

  it("toggles edit mode", () => {
    useGridStore.getState().toggleEditMode();
    expect(useGridStore.getState().editMode).toBe(true);
    useGridStore.getState().toggleEditMode();
    expect(useGridStore.getState().editMode).toBe(false);
  });

  it("has no focused pane initially", () => {
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("sets focused pane", () => {
    useGridStore.getState().setFocusedPane(2);
    expect(useGridStore.getState().focusedPaneIndex).toBe(2);
  });

  it("clears focused pane", () => {
    useGridStore.getState().setFocusedPane(1);
    useGridStore.getState().setFocusedPane(null);
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("sets edit mode to true", () => {
    useGridStore.getState().setEditMode(true);
    expect(useGridStore.getState().editMode).toBe(true);
  });

  it("sets edit mode to false", () => {
    useGridStore.getState().setEditMode(true);
    useGridStore.getState().setEditMode(false);
    expect(useGridStore.getState().editMode).toBe(false);
  });

  it("setEditMode is idempotent", () => {
    useGridStore.getState().setEditMode(true);
    useGridStore.getState().setEditMode(true);
    expect(useGridStore.getState().editMode).toBe(true);
  });
});
