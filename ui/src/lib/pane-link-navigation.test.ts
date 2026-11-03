import { beforeEach, expect, it } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { focusDesktopPaneLink, resolveDesktopPaneLink } from "./pane-link-navigation";
import { makeSlot } from "./pane-layers";

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState());
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useUiStore.setState(useUiStore.getInitialState());
  useDockStore.setState(useDockStore.getInitialState());
  useGridStore.setState(useGridStore.getInitialState());
  const slot = makeSlot("pane-11111111", { x: 0, y: 0, w: 1, h: 1 }, { type: "TerminalView" });
  slot.layers.push({ id: "pane-1b7d7a95", view: { type: "TerminalView" } });
  useWorkspaceStore.setState({
    activeWorkspaceId: "ws-a",
    workspaces: [
      {
        id: "ws-a",
        name: "Current",
        panes: [makeSlot("pane-aaaaaaaa", { x: 0, y: 0, w: 1, h: 1 }, { type: "TerminalView" })],
      },
      { id: "ws-b", name: "laymux-0", panes: [slot] },
    ],
  });
  useUiStore.setState({
    hiddenWorkspaceIds: new Set(["ws-b"]),
    hiddenPaneIds: new Set(["pane-1b7d7a95"]),
  });
});

it.each(["terminal-pane-1b7d7a95", "pane-1b7d7a95", "lx:pane:laymux-0:2"])(
  "%s가 숨은 workspace와 스택 레이어로 이동·포커스한다",
  (text) => {
    const target = resolveDesktopPaneLink(text)!;
    expect(target.terminalId).toBe("terminal-pane-1b7d7a95");
    expect(focusDesktopPaneLink(target)).toBe(true);
    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("ws-b");
    expect(state.workspaces[1].panes[0].activeLayerId).toBe("pane-1b7d7a95");
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-b")).toBe(false);
    expect(useUiStore.getState().hiddenPaneIds.has("pane-1b7d7a95")).toBe(false);
  },
);
it("설정을 끄면 기존 대상도 탐색하지 않는다", () => {
  const target = resolveDesktopPaneLink("pane-1b7d7a95")!;
  useSettingsStore.getState().setTerminal({ paneLinkEnabled: false });
  expect(resolveDesktopPaneLink("pane-1b7d7a95")).toBeNull();
  expect(focusDesktopPaneLink(target)).toBe(false);
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
});
it("삭제된 대상은 포커스·숨김 상태를 바꾸지 않는다", () => {
  const target = resolveDesktopPaneLink("pane-1b7d7a95")!;
  useWorkspaceStore.setState({ workspaces: useWorkspaceStore.getState().workspaces.slice(0, 1) });
  expect(focusDesktopPaneLink(target)).toBe(false);
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
  expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-b")).toBe(true);
});
