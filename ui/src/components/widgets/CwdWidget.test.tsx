import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({ clipboardWriteText: vi.fn() }));

import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CwdWidget } from "./CwdWidget";

describe("CwdWidget", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
  });

  it("shows the actual active pane CWD instead of stale terminal focus metadata", () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws-current",
      workspaces: [
        {
          id: "ws-stale",
          name: "Stale",
          panes: [
            {
              id: "stale",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView" },
            },
          ],
        },
        {
          id: "ws-current",
          name: "Current",
          panes: [
            {
              id: "current",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView" },
            },
          ],
        },
      ],
    });
    useTerminalStore.setState({
      instances: [
        {
          id: "terminal-stale",
          profile: "WSL",
          syncGroup: "ws-stale",
          workspaceId: "ws-stale",
          label: "stale",
          cwd: "/home/dev/stale",
          lastActivityAt: 0,
          isFocused: true,
        },
        {
          id: "terminal-current",
          profile: "WSL",
          syncGroup: "ws-current",
          workspaceId: "ws-current",
          label: "current",
          cwd: "/home/dev/current",
          lastActivityAt: 0,
          isFocused: false,
        },
      ],
    });

    render(<CwdWidget instance={{ id: "cwd", type: "cwd", options: {} }} />);

    expect(screen.getByTestId("widget-cwd-cwd")).toHaveAttribute(
      "title",
      expect.stringContaining("/home/dev/current"),
    );
  });
});
