import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/tauri-api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
}));

import { matchesGlobalShortcut, useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useSettingsStore } from "@/stores/settings-store";
import { makeSlot } from "@/lib/pane-layers";
import type { WorkspacePane } from "@/stores/types";

/** Pane stack keyboard behavior (ADR-0297). */
function fireKey(
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  const event = new KeyboardEvent("keydown", { key, ...mods, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

const term = { type: "TerminalView" as const };

/** Left single slot + right stack [r0, r1, r2] with r0 active. */
function seed(): void {
  const stack: WorkspacePane = {
    id: "r0",
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 1,
    layers: [
      { id: "r0", view: term },
      { id: "r1", view: term },
      { id: "r2", view: { type: "MemoView" } },
    ],
    activeLayerId: "r0",
  };
  useWorkspaceStore.setState({
    activeWorkspaceId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "WS",
        panes: [makeSlot("left", { x: 0, y: 0, w: 0.5, h: 1 }, term), stack],
      },
    ],
  });
  useGridStore.setState({ focusedPaneIndex: 1 });
}

function activeLayerOfRight(): string {
  return useWorkspaceStore.getState().workspaces[0].panes[1].activeLayerId;
}

function hideDocks(): void {
  useDockStore.setState((state) => ({
    docks: state.docks.map((dock) => ({ ...dock, visible: false })),
  }));
}

describe("useKeyboardShortcuts — pane stacks", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    seed();
    hideDocks();
  });

  it("Alt+Shift+Right/Down step forward and Left/Up step backward around the ring", () => {
    renderHook(() => useKeyboardShortcuts());
    expect(fireKey("ArrowRight", { altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(activeLayerOfRight()).toBe("r1");
    fireKey("ArrowDown", { altKey: true, shiftKey: true });
    expect(activeLayerOfRight()).toBe("r2");
    fireKey("ArrowRight", { altKey: true, shiftKey: true });
    expect(activeLayerOfRight()).toBe("r0");
    fireKey("ArrowLeft", { altKey: true, shiftKey: true });
    expect(activeLayerOfRight()).toBe("r2");
    fireKey("ArrowUp", { altKey: true, shiftKey: true });
    expect(activeLayerOfRight()).toBe("r1");
    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("Alt+Shift+Arrow on an unstacked slot is a no-op", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());
    fireKey("ArrowRight", { altKey: true, shiftKey: true });
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(activeLayerOfRight()).toBe("r0");
  });

  it("Ctrl+Alt+S stacks a new layer on the focused slot and shows it", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());
    expect(fireKey("s", { ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
    const left = useWorkspaceStore.getState().workspaces[0].panes[0];
    expect(left.layers).toHaveLength(2);
    expect(left.activeLayerId).toBe(left.layers[1].id);
    expect(left.layers[1].view).toEqual({ type: "EmptyView" });
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow still moves between slots when a neighbor exists", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("ArrowLeft", { altKey: true });
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(activeLayerOfRight()).toBe("r0");
  });

  it("Alt+Arrow into a dead end cycles the focused stack when enabled", () => {
    renderHook(() => useKeyboardShortcuts());
    fireKey("ArrowUp", { altKey: true });
    expect(activeLayerOfRight()).toBe("r2");
    fireKey("ArrowDown", { altKey: true });
    expect(activeLayerOfRight()).toBe("r0");
    fireKey("ArrowRight", { altKey: true });
    expect(activeLayerOfRight()).toBe("r1");
  });

  it("does not cycle on a dead end when the setting is off", () => {
    useSettingsStore.getState().setPaneStack({ cycleOnBlockedArrow: false });
    renderHook(() => useKeyboardShortcuts());
    fireKey("ArrowRight", { altKey: true });
    expect(activeLayerOfRight()).toBe("r0");
  });

  it("prefers entering a visible dock over cycling the stack", () => {
    useDockStore.setState((state) => ({
      docks: state.docks.map((dock) =>
        dock.position === "right" ? { ...dock, visible: true } : dock,
      ),
    }));
    const right = useDockStore.getState().getDock("right")!;
    expect(right.panes.length).toBeGreaterThan(0);
    renderHook(() => useKeyboardShortcuts());
    fireKey("ArrowRight", { altKey: true });
    expect(useDockStore.getState().focusedDock).toBe("right");
    expect(activeLayerOfRight()).toBe("r0");
  });
});

describe("matchesGlobalShortcut — pane.layer follows the stack gate (ADR-0297)", () => {
  const altShiftRight = () =>
    new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true });

  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    seed();
    hideDocks();
  });

  it("claims Alt+Shift+Arrow while the focused slot is a stack", () => {
    useGridStore.setState({ focusedPaneIndex: 1 });
    expect(matchesGlobalShortcut(altShiftRight())).toBe(true);
  });

  it("leaves Alt+Shift+Arrow to the PTY on an unstacked slot", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    expect(matchesGlobalShortcut(altShiftRight())).toBe(false);
  });

  it("leaves Alt+Shift+Arrow to the PTY while a dock is focused", () => {
    useDockStore.setState({ focusedDock: "left" });
    expect(matchesGlobalShortcut(altShiftRight())).toBe(false);
  });

  it("still claims ungated shortcuts on an unstacked slot", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    expect(
      matchesGlobalShortcut(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true })),
    ).toBe(true);
  });
});
