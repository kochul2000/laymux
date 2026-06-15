import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { RenameWorkspaceOverlay } from "./RenameWorkspaceOverlay";
import { useRenameWorkspaceStore } from "@/stores/rename-workspace-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

describe("RenameWorkspaceOverlay", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useRenameWorkspaceStore.setState({ targetId: null, currentName: "" });
  });

  it("renders nothing when closed", () => {
    render(<RenameWorkspaceOverlay />);
    expect(screen.queryByTestId("rename-workspace-overlay")).not.toBeInTheDocument();
  });

  it("shows the input seeded with the current name when opened", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    const input = screen.getByTestId("rename-workspace-overlay-input") as HTMLInputElement;
    expect(input.value).toBe("Default");
  });

  it("renames the workspace and closes on Enter", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    const input = screen.getByTestId("rename-workspace-overlay-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Renamed");
    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("renames the workspace and closes on the Rename button", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    const input = screen.getByTestId("rename-workspace-overlay-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "ViaButton" } });
    fireEvent.click(screen.getByTestId("rename-workspace-overlay-submit"));

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("ViaButton");
    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("ignores a blank name (does not rename) but still closes", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    const input = screen.getByTestId("rename-workspace-overlay-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("cancels without renaming on Escape", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    const input = screen.getByTestId("rename-workspace-overlay-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("cancels without renaming on the Cancel button", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);

    fireEvent.click(screen.getByTestId("rename-workspace-overlay-cancel"));

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("cancels on backdrop click", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);

    fireEvent.click(screen.getByTestId("rename-workspace-overlay-backdrop"));

    expect(useRenameWorkspaceStore.getState().targetId).toBeNull();
  });

  it("exposes a labelled modal dialog for screen readers", () => {
    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The accessible name comes from the title via aria-labelledby.
    expect(dialog).toHaveAccessibleName("Rename workspace");
  });

  it("restores focus to the previously focused element on close", () => {
    // Simulate the rename shortcut firing while another element (e.g. a terminal)
    // holds focus.
    const prev = document.createElement("button");
    document.body.appendChild(prev);
    prev.focus();
    expect(document.activeElement).toBe(prev);

    act(() => useRenameWorkspaceStore.getState().openRename("ws-default", "Default"));
    render(<RenameWorkspaceOverlay />);
    // The overlay input steals focus while open.
    expect(document.activeElement).not.toBe(prev);

    act(() => useRenameWorkspaceStore.getState().closeRename());
    // On close, focus returns to where it was before the overlay opened.
    expect(document.activeElement).toBe(prev);

    prev.remove();
  });
});
