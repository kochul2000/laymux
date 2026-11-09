import { render, act, fireEvent, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

// Records the terminal session lifecycle: TerminalView opens its PTY in a
// mount effect and closes it in the cleanup, so an extra cleanup here is a
// lost shell in the real app.
const lifecycle: string[] = [];
vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: (props: { instanceId: string }) => {
    useEffect(() => {
      lifecycle.push(`open ${props.instanceId}`);
      return () => void lifecycle.push(`close ${props.instanceId}`);
    }, [props.instanceId]);
    return <div data-testid={`mock-terminal-${props.instanceId}`} />;
  },
}));

import { WorkspaceArea } from "./WorkspaceArea";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";

const terminal = { type: "TerminalView" } as const;

// ADR-0297: moving, extracting and merging layers must keep each terminal's
// session. Rendered without <StrictMode> on purpose: in development React 19
// StrictMode re-runs the effects of a keyed child that moves past its
// siblings, which closes and reopens the PTY in a dev build only. Release
// builds do not wrap the app in StrictMode, and that is what this guards.
describe("WorkspaceArea stack rearrangement keeps terminal sessions (ADR-0297)", () => {
  beforeEach(() => {
    lifecycle.length = 0;
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    const state = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      workspaces: state.workspaces.map((w) =>
        w.id === state.activeWorkspaceId
          ? {
              ...w,
              panes: [
                {
                  id: "A",
                  x: 0,
                  y: 0,
                  w: 0.5,
                  h: 1,
                  layers: [
                    { id: "A", view: terminal },
                    { id: "L", view: terminal },
                  ],
                  activeLayerId: "L",
                },
                {
                  id: "B",
                  x: 0.5,
                  y: 0,
                  w: 0.5,
                  h: 1,
                  layers: [
                    { id: "B", view: terminal },
                    { id: "C", view: terminal },
                  ],
                  activeLayerId: "C",
                },
              ],
            }
          : w,
      ),
    });
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(["A", "L", "B", "C"]) });
  });

  it.each(["A", "L", "last"])("+ appends at the right edge when %s is active", (activeId) => {
    const store = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      workspaces: store.workspaces.map((ws) => ({
        ...ws,
        panes: ws.panes.map((pane, index) =>
          index === 0
            ? {
                ...pane,
                layers: [
                  { id: "A", view: { ...terminal, profile: "first", lastCwd: "/first" } },
                  { id: "L", view: { ...terminal, profile: "middle", lastCwd: "/middle" } },
                  { id: "last", view: { ...terminal, profile: "last", lastCwd: "/last" } },
                ],
                activeLayerId: activeId,
              }
            : pane,
        ),
      })),
    });
    useTerminalStartupStore.setState({ revealedPaneIds: new Set(["A", "L", "last", "B", "C"]) });
    const source = useWorkspaceStore
      .getState()
      .getActiveWorkspace()!
      .panes[0].layers.find((layer) => layer.id === activeId)!;
    render(<WorkspaceArea />);
    const strip = screen.getAllByTestId("pane-stack-strip")[0];
    lifecycle.length = 0;
    fireEvent.click(within(strip).getByTestId("pane-stack-add"));

    const slot = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0];
    const addedId = slot.activeLayerId;
    expect(slot.layers.map((layer) => layer.id)).toEqual(["A", "L", "last", addedId]);
    expect(
      within(screen.getAllByTestId("pane-stack-strip")[0])
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("data-testid")),
    ).toEqual(["A", "L", "last", addedId].map((id) => `pane-stack-tab-${id}`));
    expect(slot.layers.at(-1)?.view).toEqual({
      type: "TerminalView",
      profile: source.view.profile,
    });
    expect(useTerminalRestartStore.getState().requests[addedId]?.cwd).toBe(source.view.lastCwd);
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(lifecycle.filter((entry) => entry.startsWith("close "))).toEqual([]);
  });

  it("keeps the session of a layer moved past another slot's layers", () => {
    render(<WorkspaceArea />);
    lifecycle.length = 0;
    act(() => {
      useWorkspaceStore.getState().moveLayer("L", "B");
    });
    expect(lifecycle).toEqual([]);
  });

  it("keeps every session through extract and merge", () => {
    render(<WorkspaceArea />);
    lifecycle.length = 0;
    act(() => {
      useWorkspaceStore.getState().extractLayer("L", "vertical");
    });
    act(() => {
      const panes = useWorkspaceStore.getState().getActiveWorkspace()!.panes;
      const extracted = panes.find((p) => p.layers.some((l) => l.id === "L"))!;
      useWorkspaceStore.getState().mergeSlotIntoStack(extracted.id, "B");
    });
    expect(lifecycle).toEqual([]);
  });
});
