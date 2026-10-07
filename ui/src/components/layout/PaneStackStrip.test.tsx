import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { PaneLayer } from "@/stores/types";

import { PaneStackStrip } from "./PaneStackStrip";

const layers: PaneLayer[] = [
  { id: "a", view: { type: "TerminalView", profile: "WSL" } },
  { id: "b", view: { type: "MemoView" } },
  { id: "c", view: { type: "TerminalView" } },
];

describe("PaneStackStrip (ADR-0297)", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
  });

  it("renders a tab per layer with number, title and the active marker", () => {
    useTerminalStore.getState().registerInstance({
      id: "terminal-c",
      profile: "PowerShell",
      syncGroup: "g",
      workspaceId: "ws",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-c", { title: "npm run dev" });
    render(
      <PaneStackStrip
        layers={layers}
        activeLayerId="b"
        paneNumbers={
          new Map([
            ["a", 2],
            ["b", 3],
            ["c", 4],
          ])
        }
        onActivate={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["2WSL", "3Memo", "4npm run dev"]);
    expect(screen.getByTestId("pane-stack-tab-b").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("pane-stack-tab-a").getAttribute("aria-selected")).toBe("false");
  });

  it("activates on click, closes on × or middle click, and adds with +", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const onAdd = vi.fn();
    render(
      <PaneStackStrip
        layers={layers}
        activeLayerId="a"
        onActivate={onActivate}
        onClose={onClose}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByTestId("pane-stack-tab-b"));
    expect(onActivate).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getByTestId("pane-stack-tab-close-c"));
    expect(onClose).toHaveBeenCalledWith("c");
    expect(onActivate).toHaveBeenCalledTimes(1);

    fireEvent(
      screen.getByTestId("pane-stack-tab-a"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getByTestId("pane-stack-add"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("marks unread terminals over output activity", () => {
    useTerminalStore.getState().registerInstance({
      id: "terminal-a",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-a", { outputActive: true });
    useTerminalStore.getState().registerInstance({
      id: "terminal-c",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-c", { outputActive: true });
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-c",
      workspaceId: "ws",
      message: "done",
      level: "info",
    });
    render(<PaneStackStrip layers={layers} activeLayerId="b" onActivate={vi.fn()} />);
    expect(screen.getByTestId("pane-stack-tab-dot-a").getAttribute("data-kind")).toBe("active");
    expect(screen.getByTestId("pane-stack-tab-dot-c").getAttribute("data-kind")).toBe("unread");
    expect(screen.queryByTestId("pane-stack-tab-dot-b")).toBeNull();
  });

  it("omits close and add controls when not provided", () => {
    render(<PaneStackStrip layers={layers} activeLayerId="a" onActivate={vi.fn()} />);
    expect(screen.queryByTestId("pane-stack-add")).toBeNull();
    expect(screen.queryByTestId("pane-stack-tab-close-a")).toBeNull();
  });
});
