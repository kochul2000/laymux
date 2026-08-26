import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { GridEditToolbar } from "./GridEditToolbar";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { useSettingsStore } from "@/stores/settings-store";
import { defaultWidgets } from "@/lib/widget-placement";

describe("GridEditToolbar", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useFileViewerStore.setState(useFileViewerStore.getInitialState());
    useRemoteAccessStore.setState(useRemoteAccessStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("leaves layout export to the workspace selector view", () => {
    // Export New moved next to the layout cards it creates (WorkspaceSelectorView);
    // the top bar owns window/dock controls only.
    render(<GridEditToolbar />);
    expect(screen.queryByTestId("export-new-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("layout-saved-indicator")).not.toBeInTheDocument();
  });

  it("renders dock toggle buttons for all 4 positions", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("dock-toggle-top").querySelector(".lucide-panel-top")).toBeVisible();
    expect(
      screen.getByTestId("dock-toggle-bottom").querySelector(".lucide-panel-bottom"),
    ).toBeVisible();
    expect(
      screen.getByTestId("dock-toggle-left").querySelector(".lucide-panel-left"),
    ).toBeVisible();
    expect(
      screen.getByTestId("dock-toggle-right").querySelector(".lucide-panel-right"),
    ).toBeVisible();
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

    // Top dock is hidden on first install; clicking toggles it on then off.
    expect(useDockStore.getState().getDock("top")!.visible).toBe(false);
    await user.click(screen.getByTestId("dock-toggle-top"));
    expect(useDockStore.getState().getDock("top")!.visible).toBe(true);
    await user.click(screen.getByTestId("dock-toggle-top"));
    expect(useDockStore.getState().getDock("top")!.visible).toBe(false);
  });

  it("renders the file viewer button", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("file-viewer-btn")).toBeInTheDocument();
  });

  it("renders the file viewer button with the Lucide file-search icon", () => {
    render(<GridEditToolbar />);
    expect(
      screen.getByTestId("file-viewer-btn").querySelector(".lucide-file-search"),
    ).toBeInTheDocument();
  });

  it("opens the empty file viewer on click", async () => {
    const user = userEvent.setup();
    render(<GridEditToolbar />);

    expect(useFileViewerStore.getState().open).toBe(false);
    await user.click(screen.getByTestId("file-viewer-btn"));
    expect(useFileViewerStore.getState().open).toBe(true);
    expect(useFileViewerStore.getState().path).toBe("");
  });

  it("keeps a window drag region no matter how full the widget slots are", () => {
    // Without a floor, a crowded top bar would leave nothing to grab the window
    // by — placement must cost widgets, never the ability to move the window.
    useSettingsStore.setState({
      widgets: {
        ...defaultWidgets(),
        topBar: {
          left: [{ id: "w1", type: "cwd", options: {} }],
          right: [{ id: "w2", type: "claudeUsage", options: {} }],
        },
      },
    });
    render(<GridEditToolbar />);

    const dragRegions = document.querySelectorAll<HTMLElement>("[data-tauri-drag-region]");
    const reserved = Array.from(dragRegions).find((element) => element.style.minWidth !== "");
    expect(reserved).toBeDefined();
    expect(parseInt(reserved!.style.minWidth, 10)).toBeGreaterThan(0);
  });

  it("renders both top bar widget slots", () => {
    render(<GridEditToolbar />);
    expect(screen.getByTestId("widget-slot-topBar-left")).toBeInTheDocument();
    expect(screen.getByTestId("widget-slot-topBar-right")).toBeInTheDocument();
  });
});
