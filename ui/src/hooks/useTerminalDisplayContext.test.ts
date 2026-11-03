import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import { useTerminalDisplayContext } from "./useTerminalDisplayContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
const history = {
  version: 1 as const,
  profile: "PowerShell",
  lastUserInput: "retained input",
  lastUserInputAt: 123,
};
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue({});
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useDockStore.setState(useDockStore.getInitialState());
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useTerminalDisplayStore.setState({ contexts: {} });
});

it("does not resurrect deleted content from a delayed daemon history response", async () => {
  const workspace = useWorkspaceStore.getState().workspaces[0];
  const pane = workspace.panes[0];
  const layer = pane.layers[0];
  const id = `terminal-${layer.id}`;
  useWorkspaceStore.setState({
    workspaces: [
      {
        ...workspace,
        panes: [
          {
            ...pane,
            layers: [{ ...layer, view: { type: "TerminalView", profile: "PowerShell" } }],
          },
        ],
      },
    ],
  });
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = renderHook(() => useTerminalDisplayContext(true));
  act(() => useWorkspaceStore.setState({ workspaces: [{ ...workspace, panes: [] }] }));
  await act(async () => finish({ [id]: history }));
  expect(useTerminalDisplayStore.getState().contexts[id]).toBeUndefined();
  unmount();
});

it("keeps hidden unmount history but removes it on content deletion or profile replacement", () => {
  const workspace = useWorkspaceStore.getState().workspaces[0];
  const pane = workspace.panes[0];
  const layer = pane.layers[0];
  const id = `terminal-${layer.id}`;
  useWorkspaceStore.setState({
    workspaces: [
      {
        ...workspace,
        panes: [
          {
            ...pane,
            layers: [{ ...layer, view: { type: "TerminalView", profile: "PowerShell" } }],
          },
        ],
      },
    ],
  });
  useTerminalStore.getState().registerInstance({
    id,
    profile: "PowerShell",
    workspaceId: workspace.id,
    syncGroup: workspace.id,
  });
  useTerminalDisplayStore.getState().setContext(id, history);
  const { unmount } = renderHook(() => useTerminalDisplayContext(true));
  act(() => useTerminalStore.getState().unregisterInstance(id));
  expect(useTerminalDisplayStore.getState().contexts[id]).toBe(history);
  act(() => useWorkspaceStore.setState({ workspaces: [{ ...workspace, panes: [] }] }));
  expect(useTerminalDisplayStore.getState().contexts[id]).toBeUndefined();
  act(() => {
    useTerminalDisplayStore.getState().setContext(id, history);
    useWorkspaceStore.setState({
      workspaces: [
        {
          ...workspace,
          panes: [
            { ...pane, layers: [{ ...layer, view: { type: "TerminalView", profile: "WSL" } }] },
          ],
        },
      ],
    });
  });
  expect(useTerminalDisplayStore.getState().contexts[id]).toBeUndefined();
  unmount();
});

it("prunes deleted dock content even when its terminal is not mounted", () => {
  const dock = useDockStore.getState().docks[0];
  const pane = {
    id: "display-dock",
    view: { type: "TerminalView" as const, profile: "PowerShell" },
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  };
  useDockStore.setState({ docks: [{ ...dock, panes: [pane] }] });
  useTerminalDisplayStore.getState().setContext("terminal-display-dock", history);
  const { unmount } = renderHook(() => useTerminalDisplayContext(true));
  act(() => useDockStore.setState({ docks: [{ ...dock, panes: [] }] }));
  expect(useTerminalDisplayStore.getState().contexts["terminal-display-dock"]).toBeUndefined();
  unmount();
});
