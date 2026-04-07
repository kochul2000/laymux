import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { GridEditToolbar } from "./GridEditToolbar";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";

describe("GridEditToolbar", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
  });

  it("always shows export action buttons", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("export-new-btn")).toBeInTheDocument();
  });

  it("export-new button creates new layout with prompted name", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("My Layout");
    useWorkspaceStore.getState().splitPane(0, "horizontal");

    render(<GridEditToolbar />);
    await user.click(screen.getByTestId("export-new-btn"));

    expect(useWorkspaceStore.getState().layouts).toHaveLength(2);
    expect(useWorkspaceStore.getState().layouts[1].name).toBe("My Layout");
    promptSpy.mockRestore();
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

  it("shows Saved! after export-new", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "prompt").mockReturnValue("Test Layout");
    render(<GridEditToolbar />);

    await user.click(screen.getByTestId("export-new-btn"));

    expect(screen.getByTestId("layout-saved-indicator")).toHaveTextContent("Saved!");
  });

});
