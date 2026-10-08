import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { makeSlot } from "./pane-layers";
import { preserveTerminalSourceOnUnmount } from "./terminal-surface-lifecycle";

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "ws",
        panes: [makeSlot("content", { x: 0, y: 0, w: 1, h: 1 }, { type: "TerminalView" })],
      },
    ],
  });
  useDockStore.setState({ docks: [] });
  useSettingsStore.setState({ defaultProfile: "PowerShell" });
  useTerminalRestartStore.setState({ requests: {} });
});

describe("terminal source lifetime", () => {
  it("preserves declared content when the renderer unmounts", () => {
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 0)).toBe(true);
  });
  it("closes removed content and a changed profile", () => {
    expect(preserveTerminalSourceOnUnmount("content", "Ubuntu", 0)).toBe(false);
    useWorkspaceStore.setState({ workspaces: [] });
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 0)).toBe(false);
  });
  it("closes the old restart epoch even after the new renderer consumes the request", () => {
    useTerminalRestartStore.getState().requestRestart("content");
    useTerminalRestartStore.getState().consumeRestart("content");
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 0)).toBe(false);
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 1)).toBe(true);
  });
  it("preserves an inactive stack layer", () => {
    const workspaces = useWorkspaceStore.getState().workspaces;
    const slot = workspaces[0].panes[0];
    useWorkspaceStore.setState({
      workspaces: [
        {
          ...workspaces[0],
          panes: [
            {
              ...slot,
              layers: [...slot.layers, { id: "other", view: { type: "EmptyView" } }],
              activeLayerId: "other",
            },
          ],
        },
      ],
    });
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 0)).toBe(true);
  });
  it("preserves a hidden dock terminal", () => {
    useWorkspaceStore.setState({ workspaces: [] });
    useDockStore.setState({
      docks: [
        {
          position: "bottom",
          activeView: "TerminalView",
          views: [],
          visible: false,
          size: 200,
          panes: [{ id: "content", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }],
        },
      ],
    });
    expect(preserveTerminalSourceOnUnmount("content", "PowerShell", 0)).toBe(true);
  });
});
