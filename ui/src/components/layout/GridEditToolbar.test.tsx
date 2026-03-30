import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { GridEditToolbar } from "./GridEditToolbar";
import { useGridStore } from "@/stores/grid-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";

describe("GridEditToolbar", () => {
  beforeEach(() => {
    useGridStore.setState(useGridStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
  });

  it("renders edit mode toggle button", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("edit-mode-toggle")).toBeInTheDocument();
  });

  it("toggles edit mode on click", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    await user.click(screen.getByTestId("edit-mode-toggle"));
    expect(useGridStore.getState().editMode).toBe(true);

    await user.click(screen.getByTestId("edit-mode-toggle"));
    expect(useGridStore.getState().editMode).toBe(false);
  });

  it("shows export action buttons in edit mode", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    await user.click(screen.getByTestId("edit-mode-toggle"));
    expect(screen.getByTestId("export-new-btn")).toBeInTheDocument();
    expect(screen.getByTestId("export-overwrite-select")).toBeInTheDocument();
  });

  it("does not show split/clear/delete buttons in edit mode (moved to pane control bar)", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    await user.click(screen.getByTestId("edit-mode-toggle"));
    expect(screen.queryByTestId("split-horizontal-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("split-vertical-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clear-view-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-pane-btn")).not.toBeInTheDocument();
  });

  it("export-new button creates new layout with prompted name", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("My Layout");
    useWorkspaceStore.getState().splitPane(0, "horizontal");

    render(<GridEditToolbar />);
    await user.click(screen.getByTestId("edit-mode-toggle"));
    await user.click(screen.getByTestId("export-new-btn"));

    expect(useWorkspaceStore.getState().layouts).toHaveLength(2);
    expect(useWorkspaceStore.getState().layouts[1].name).toBe("My Layout");
    promptSpy.mockRestore();
  });

  it("export-overwrite select overwrites existing layout", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.getState().splitPane(0, "vertical");

    render(<GridEditToolbar />);
    await user.click(screen.getByTestId("edit-mode-toggle"));

    const select = screen.getByTestId("export-overwrite-select");
    await user.selectOptions(select, "default-layout");

    const layout = useWorkspaceStore.getState().layouts[0];
    expect(layout.panes).toHaveLength(2);
  });

  it("renders dock toggle buttons for all 4 positions", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("dock-toggle-top")).toBeInTheDocument();
    expect(screen.getByTestId("dock-toggle-bottom")).toBeInTheDocument();
    expect(screen.getByTestId("dock-toggle-left")).toBeInTheDocument();
    expect(screen.getByTestId("dock-toggle-right")).toBeInTheDocument();
  });

  it("toggles left dock visibility on click", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    expect(useDockStore.getState().getDock("left")!.visible).toBe(true);
    await user.click(screen.getByTestId("dock-toggle-left"));
    expect(useDockStore.getState().getDock("left")!.visible).toBe(false);
    await user.click(screen.getByTestId("dock-toggle-left"));
    expect(useDockStore.getState().getDock("left")!.visible).toBe(true);
  });

  it("toggles top dock visibility on click", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    expect(useDockStore.getState().getDock("top")!.visible).toBe(true);
    await user.click(screen.getByTestId("dock-toggle-top"));
    expect(useDockStore.getState().getDock("top")!.visible).toBe(false);
  });
});
