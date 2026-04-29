import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

import { useContext, useEffect, type ReactNode } from "react";
import { PaneControlBar } from "./PaneControlBar";
import { PaneControlContext } from "./PaneControlContext";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";

describe("PaneControlBar", () => {
  const defaultView = { type: "TerminalView" as const, profile: "PowerShell" };
  const defaultActions = {
    onSplitH: vi.fn(),
    onSplitV: vi.fn(),
    onClear: vi.fn(),
    onChangeView: vi.fn(),
  };

  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    localStorage.clear();
    // 기존 테스트는 hover를 기본 모드로 가정
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "hover" },
    }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPaneWidth(width: number) {
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        private callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element) {
          setTimeout(() => {
            this.callback(
              [
                {
                  target,
                  contentRect: { width, height: 600 },
                } as unknown as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            );
          }, 0);
        }

        unobserve() {}
        disconnect() {}
      },
    );
  }

  // -- Hover mode (default) --

  it("does not show bar when not hovered", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
  });

  it("shows bar when hovered", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
  });

  it("bar contains view selector, split, clear, pin, minimize buttons", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-view-select")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-h")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-v")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-clear")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-pin")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-minimize")).toBeInTheDocument();
  });

  it("split H calls onSplitH", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-split-h"));
    expect(defaultActions.onSplitH).toHaveBeenCalled();
  });

  it("split V calls onSplitV", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-split-v"));
    expect(defaultActions.onSplitV).toHaveBeenCalled();
  });

  it("clear calls onClear", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-clear"));
    expect(defaultActions.onClear).toHaveBeenCalled();
  });

  // -- Pinned mode --

  it("clicking pin toggles to pinned mode", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-pin"));
    // Now in pinned mode — bar should persist even without hover
    expect(screen.getByTestId("pane-control-pinned")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
  });

  it("keeps pin available in the narrow hover menu", async () => {
    stubPaneWidth(320);
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));

    const pinButton = screen.getByTestId("pane-control-pin");
    expect(pinButton).toHaveAttribute("title", "Pin");

    await user.click(pinButton);
    expect(screen.getByTestId("pane-control-pinned")).toBeInTheDocument();
  });

  it("keeps unpin available in the narrow pinned menu", async () => {
    stubPaneWidth(320);
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "pinned" },
    }));
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));

    const unpinButton = screen.getByTestId("pane-control-pin");
    expect(unpinButton).toHaveAttribute("title", "Unpin");

    await user.click(unpinButton);
    expect(screen.getByTestId("pane-control-hover")).toBeInTheDocument();
  });

  // -- Minimized mode --

  it("clicking minimize shows menu button", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-minimize"));
    expect(screen.getByTestId("pane-control-minimized")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument();
  });

  it("menu button expands full bar in-place", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    // Switch to minimized
    await user.click(screen.getByTestId("pane-control-minimize"));
    // Click menu button — should expand the full control bar
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-split-h")).toBeInTheDocument();
  });

  it("clicking minimize again in expanded state collapses back to button", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    // Minimize → expand → minimize again
    await user.click(screen.getByTestId("pane-control-minimize"));
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    // Now bar is expanded, click minimize in the bar
    await user.click(screen.getByTestId("pane-control-minimize"));
    // Should be back to just the button
    expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
  });

  // -- Delete pane --

  it("shows delete button when onDelete is provided", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    // defaultActions doesn't have onDelete, so no delete button
    expect(screen.queryByTestId("pane-control-delete")).not.toBeInTheDocument();
  });

  it("shows delete button when onDelete action exists", () => {
    const actionsWithDelete = { ...defaultActions, onDelete: vi.fn() };
    render(
      <PaneControlBar currentView={defaultView} actions={actionsWithDelete} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-delete")).toBeInTheDocument();
  });

  it("calls onDelete when delete button clicked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const actionsWithDelete = { ...defaultActions, onDelete };
    render(
      <PaneControlBar currentView={defaultView} actions={actionsWithDelete} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    await user.click(screen.getByTestId("pane-control-delete"));
    expect(onDelete).toHaveBeenCalled();
  });

  it("view selector includes Memo option", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    const select = screen.getByTestId("pane-control-view-select") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("MemoView");
  });

  it("selecting Memo calls onChangeView with MemoView type", async () => {
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    const select = screen.getByTestId("pane-control-view-select");
    await user.selectOptions(select, "MemoView");
    expect(defaultActions.onChangeView).toHaveBeenCalledWith({ type: "MemoView" });
  });

  it("renders children content in all modes", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div data-testid="child">content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  // -- Persistence via paneId --

  it("persists mode per paneId in overrides-store", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <PaneControlBar
        paneId="pane-abc"
        currentView={defaultView}
        actions={defaultActions}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    // Pin the bar
    await user.click(screen.getByTestId("pane-control-pin"));
    expect(screen.getByTestId("pane-control-pinned")).toBeInTheDocument();
    // Mode should be stored in overrides-store as a pane instance override
    expect(useOverridesStore.getState().getPaneOverride("pane-abc")?.controlBarMode).toBe("pinned");
    unmount();

    // Re-render — mode should be restored from store
    render(
      <PaneControlBar
        paneId="pane-abc"
        currentView={defaultView}
        actions={defaultActions}
        hovered={false}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-pinned")).toBeInTheDocument();
  });

  // -- Default mode from settings --

  it("uses defaultControlBarMode from settings when no persisted mode", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "minimized" },
    }));
    render(
      <PaneControlBar
        paneId="pane-new"
        currentView={defaultView}
        actions={defaultActions}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-minimized")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument();
  });

  it("uses pinned as default when configured", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "pinned" },
    }));
    render(
      <PaneControlBar
        paneId="pane-new2"
        currentView={defaultView}
        actions={defaultActions}
        hovered={false}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-pinned")).toBeInTheDocument();
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
  });

  // -- Left bar content injection (issue #209) --

  function LeftContentInjector({ node }: { node: ReactNode }) {
    const ctx = useContext(PaneControlContext);
    useEffect(() => {
      ctx?.setLeftBarContent(node);
      return () => ctx?.setLeftBarContent(null);
    }, [ctx, node]);
    return null;
  }

  it("renders a child-injected left bar node on the pinned bar", () => {
    useSettingsStore.setState((s) => ({
      convenience: { ...s.convenience, defaultControlBarMode: "pinned" },
    }));
    render(
      <PaneControlBar
        paneId="pane-inject"
        currentView={defaultView}
        actions={defaultActions}
        hovered={false}
      >
        <LeftContentInjector node={<span data-testid="injected-left">LEFT_INFO</span>} />
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
    expect(screen.getByTestId("injected-left")).toHaveTextContent("LEFT_INFO");
  });

  it("does not render the pinned bar just because left content is injected (mode still decides)", () => {
    // hover 모드에서 hovered=false면 bar 자체가 표시되지 않아야 한다.
    render(
      <PaneControlBar
        paneId="pane-hov"
        currentView={defaultView}
        actions={defaultActions}
        hovered={false}
      >
        <LeftContentInjector node={<span data-testid="injected-left">INFO</span>} />
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("injected-left")).not.toBeInTheDocument();
  });

  it("renders injected left content on the hover bar when hovered", () => {
    render(
      <PaneControlBar
        paneId="pane-hov2"
        currentView={defaultView}
        actions={defaultActions}
        hovered={true}
      >
        <LeftContentInjector node={<span data-testid="injected-left">HOVER_INFO</span>} />
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-bar")).toBeInTheDocument();
    expect(screen.getByTestId("injected-left")).toHaveTextContent("HOVER_INFO");
  });
});
