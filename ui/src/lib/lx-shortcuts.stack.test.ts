import { beforeEach, describe, expect, it, vi } from "vitest";

// isLxShortcut reads user keybinding overrides and, for stack-only actions,
// whether the focused grid slot is a pane stack (ADR-0297).
const state = {
  focusedDock: null as string | null,
  focusedPaneIndex: 0 as number | null,
  layerCount: 1,
};
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ keybindings: [] }) },
}));
vi.mock("@/stores/dock-store", () => ({
  useDockStore: { getState: () => ({ focusedDock: state.focusedDock }) },
}));
vi.mock("@/stores/grid-store", () => ({
  useGridStore: { getState: () => ({ focusedPaneIndex: state.focusedPaneIndex }) },
}));
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      getActiveWorkspace: () => ({
        panes: [{ layers: Array.from({ length: state.layerCount }, (_, i) => ({ id: `l${i}` })) }],
      }),
    }),
  },
}));

import { isLxShortcut } from "./lx-shortcuts";

const altShift = (key: string) =>
  new KeyboardEvent("keydown", { key, altKey: true, shiftKey: true });

describe("isLxShortcut — pane.layer passes through only on a stack", () => {
  beforeEach(() => {
    state.focusedDock = null;
    state.focusedPaneIndex = 0;
    state.layerCount = 1;
  });

  it("leaves Alt+Shift+Arrow to the terminal app on an unstacked slot", () => {
    expect(isLxShortcut(altShift("ArrowRight"))).toBe(false);
  });

  it("takes Alt+Shift+Arrow when the focused slot is a stack", () => {
    state.layerCount = 2;
    expect(isLxShortcut(altShift("ArrowRight"))).toBe(true);
    expect(isLxShortcut(altShift("ArrowUp"))).toBe(true);
  });

  it("leaves the combo alone while a dock owns focus", () => {
    state.layerCount = 2;
    state.focusedDock = "left";
    expect(isLxShortcut(altShift("ArrowLeft"))).toBe(false);
  });

  it("always takes Ctrl+Alt+S (pane.stack) so a stack can be created", () => {
    expect(
      isLxShortcut(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, altKey: true })),
    ).toBe(true);
  });
});
