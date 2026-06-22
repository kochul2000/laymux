import { act, render, screen, waitFor } from "@testing-library/react";
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
      controlBar: { ...s.controlBar, defaultMode: "hover" },
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

  // -- pane swap drag from the control bar empty area (issue #386) --
  describe("pane swap drag (issue #386)", () => {
    it("bar is not draggable when dnd disabled", () => {
      render(
        <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
          <div>content</div>
        </PaneControlBar>,
      );
      expect(screen.getByTestId("pane-control-bar").getAttribute("draggable")).not.toBe("true");
    });

    it("bar is draggable and dragging the empty area fires onPaneDragStart", () => {
      const onPaneDragStart = vi.fn();
      render(
        <PaneControlBar
          currentView={defaultView}
          actions={defaultActions}
          hovered={true}
          dndEnabled
          onPaneDragStart={onPaneDragStart}
          onPaneDragEnd={vi.fn()}
        >
          <div>content</div>
        </PaneControlBar>,
      );
      const bar = screen.getByTestId("pane-control-bar");
      expect(bar.getAttribute("draggable")).toBe("true");
      // dragStart dispatched on the bar itself (target === currentTarget) → empty area.
      const ev = new Event("dragstart", { bubbles: true, cancelable: true });
      bar.dispatchEvent(ev);
      expect(onPaneDragStart).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(false);
    });

    it("dragging from a button (child) is ignored: preventDefault, no onPaneDragStart", () => {
      const onPaneDragStart = vi.fn();
      render(
        <PaneControlBar
          currentView={defaultView}
          actions={defaultActions}
          hovered={true}
          dndEnabled
          onPaneDragStart={onPaneDragStart}
          onPaneDragEnd={vi.fn()}
        >
          <div>content</div>
        </PaneControlBar>,
      );
      const btn = screen.getByTestId("pane-control-split-h");
      // dragStart originating on the button bubbles to the bar with target === button.
      const ev = new Event("dragstart", { bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      expect(onPaneDragStart).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
    });
  });

  it("renders the pane number badge in the bar when paneNumber is set", () => {
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={defaultActions}
        hovered={true}
        paneNumber={4}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-number-badge")).toHaveTextContent("4");
  });

  it("does not render the badge when paneNumber is unset", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-number-badge")).not.toBeInTheDocument();
  });

  it("keeps controls right-aligned with a spacer when only the badge is on the hover bar", () => {
    // paneNumber makes the hover bar full-width; without a flex-1 spacer the
    // controls would collapse next to the badge on the left and overlay content.
    const { rerender } = render(
      <PaneControlBar
        currentView={defaultView}
        actions={defaultActions}
        hovered={true}
        paneNumber={2}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const bar = screen.getByTestId("pane-control-bar");
    // full-width so the badge can sit at the left edge and controls at the right
    expect(bar.className).toContain("left-0");
    expect(bar.className).toContain("right-0");
    // a flex-1 spacer (matching the pinned bar) pushes controls to the right
    expect(Array.from(bar.children).some((c) => c.className === "flex-1")).toBe(true);

    // sanity: no badge → no spacer, bar hugs the right edge instead
    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    const compactBar = screen.getByTestId("pane-control-bar");
    expect(compactBar.className).toContain("right-0");
    expect(compactBar.className).not.toContain("left-0");
  });

  // -- Overlay transparency (issue #320) --
  // hover 오버레이 바는 평소엔 반투명(.pane-hover-bar)이고, 바 자체에 마우스가
  // 올라가면 CSS :hover 로 불투명 복귀한다. 인라인 background/backdropFilter 를
  // 쓰면 CSS :hover 가 인라인 스타일을 못 이기므로 클래스로만 스타일링한다.

  it("hover overlay bar uses the translucent .pane-hover-bar class (issue #320)", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    const bar = screen.getByTestId("pane-control-bar");
    expect(bar.className).toContain("pane-hover-bar");
  });

  it("hover overlay bar has no inline background/blur that would defeat CSS :hover (issue #320)", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    const bar = screen.getByTestId("pane-control-bar");
    expect(bar.style.background).toBe("");
    expect(bar.style.backdropFilter).toBe("");
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

  // -- Narrow pane floating menu escapes pane clipping (issue #384) --
  // 좁은 pane에서 컨트롤 메뉴가 pane의 overflow-hidden 컨테이너에 갇히지 않도록
  // document.body로 portal 렌더한다. pane 서브트리 밖에 있어야 클리핑되지 않는다.

  it("renders the narrow floating menu outside the pane subtree via a portal (issue #384)", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    const { container } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));

    const menu = screen.getByTestId("pane-control-floating-menu");
    // The menu must NOT live inside the render container (the pane subtree);
    // it is portaled to document.body so the pane's overflow-hidden can't clip it.
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    // It still escapes any ancestor stacking context via fixed positioning.
    expect(menu.className).toContain("fixed");
  });

  it("keeps the narrow menu open and actionable after the pane loses hover (issue #384)", async () => {
    // Moving the cursor toward the floating menu leaves the pane hover region.
    // The menu must stay mounted so the user can actually click its buttons.
    stubPaneWidth(200);
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    // Pane loses hover (cursor moved off the pane to reach the floating menu).
    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div>content</div>
      </PaneControlBar>,
    );

    // Menu is still there and its split button still fires.
    const splitH = screen.getByTestId("pane-control-split-h");
    await user.click(splitH);
    expect(defaultActions.onSplitH).toHaveBeenCalled();
  });

  it("closes the narrow floating menu on outside click (issue #384)", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    render(
      <div>
        <button data-testid="outside">outside</button>
        <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
          <div>content</div>
        </PaneControlBar>
      </div>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    await user.click(screen.getByTestId("outside"));
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
  });

  it("toggles the narrow floating menu closed when the trigger is clicked again (issue #384)", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    // Clicking the trigger again must close it (not reopen via the outside-click handler).
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
  });

  it("does not re-open the narrow menu after widen then re-narrow (stale-open regression, issue #385)", async () => {
    // Open while narrow, widen (menu hides), re-narrow: the menu must stay
    // closed until the user clicks again. Without resetting narrowMenuOpen on
    // narrowBar=false, the derived visibility would resurface it stale-open.
    const ros: { cb: ResizeObserverCallback; target?: Element }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback;
        target?: Element;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
          ros.push(this);
        }
        observe(target: Element) {
          this.target = target;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const emitWidth = (width: number) =>
      act(() => {
        for (const ro of ros) {
          ro.cb(
            [
              {
                target: ro.target!,
                contentRect: { width, height: 600 },
              } as unknown as ResizeObserverEntry,
            ],
            ro as unknown as ResizeObserver,
          );
        }
      });

    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    emitWidth(200);
    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    // Widen: trigger and menu disappear.
    emitWidth(500);
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );

    // Re-narrow: trigger returns but the menu must NOT be open.
    emitWidth(200);
    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();
  });

  it("keeps unpin available in the narrow pinned menu", async () => {
    stubPaneWidth(320);
    useSettingsStore.setState((s) => ({
      controlBar: { ...s.controlBar, defaultMode: "pinned" },
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
      controlBar: { ...s.controlBar, defaultMode: "minimized" },
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
      controlBar: { ...s.controlBar, defaultMode: "pinned" },
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
      controlBar: { ...s.controlBar, defaultMode: "pinned" },
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

  // -- CWD send/receive toggle indicators --
  //
  // 표시 상태는 호출자가 계산한 effective state(cwdSendOn / cwdReceiveOn)를 따른다.
  // viewConfig.cwdSend / cwdReceive를 직접 보면 syncCwdDefaults(workspace=false, dock=false)
  // 기본값이 적용되는 신규 페인에서 "꺼져 있는데 켜진 아이콘"이 표시된다 (issue: cwd-propagation-default-icon).

  const terminalView = { type: "TerminalView" as const, profile: "PowerShell" };
  const fileExplorerView = { type: "FileExplorerView" as const };

  it("shows CWD send button ON when cwdSendOn=true (regardless of viewConfig)", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onToggleCwdSend: vi.fn() }}
        cwdSendOn={true}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const btn = screen.getByTestId("pane-control-cwd-send");
    expect(btn.getAttribute("title")).toBe("CWD Send (on)");
  });

  it("shows CWD send button OFF when cwdSendOn=false (regardless of viewConfig)", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onToggleCwdSend: vi.fn() }}
        cwdSendOn={false}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const btn = screen.getByTestId("pane-control-cwd-send");
    expect(btn.getAttribute("title")).toBe("CWD Send (off)");
  });

  it("shows CWD receive button ON when cwdReceiveOn=true", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onToggleCwdReceive: vi.fn() }}
        cwdReceiveOn={true}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
  });

  it("shows CWD receive button OFF when cwdReceiveOn=false", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onToggleCwdReceive: vi.fn() }}
        cwdReceiveOn={false}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (off)",
    );
  });

  it("ignores viewConfig.cwdSend; effective state comes from cwdSendOn prop only", () => {
    // viewConfig.cwdSend is undefined (no per-pane override). Caller passed cwdSendOn=false
    // because syncCwdDefaults.workspace.send = false. The bar must show OFF, not ON.
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onToggleCwdSend: vi.fn() }}
        cwdSendOn={false}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
  });

  it("displays CWD toggles for FileExplorerView too", () => {
    render(
      <PaneControlBar
        currentView={fileExplorerView}
        actions={{
          ...defaultActions,
          onToggleCwdSend: vi.fn(),
          onToggleCwdReceive: vi.fn(),
        }}
        cwdSendOn={false}
        cwdReceiveOn={false}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-send").getAttribute("title")).toBe(
      "CWD Send (off)",
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (off)",
    );
  });

  it("hides CWD send button when no onToggleCwdSend action provided", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={defaultActions}
        cwdSendOn={false}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-cwd-send")).not.toBeInTheDocument();
  });

  // 1회성 CWD 전파 버튼 (issue #293) — 단축키 힌트 포함 (issue #324)
  it("shows the propagate-CWD-once button when onPropagateCwdOnce is provided", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const btn = screen.getByTestId("pane-control-cwd-propagate-once");
    expect(btn.getAttribute("title")).toBe("Propagate CWD once (Ctrl+Alt+P)");
  });

  // PR #331 리뷰: Settings 에서 재바인딩하면 툴팁도 즉시 갱신되어야 한다 (구독 기반).
  it("updates the tooltip when the keybinding is rebound in Settings", async () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const btn = screen.getByTestId("pane-control-cwd-propagate-once");
    expect(btn.getAttribute("title")).toBe("Propagate CWD once (Ctrl+Alt+P)");

    act(() => {
      useSettingsStore.setState({
        keybindings: [{ command: "pane.propagateCwdOnce", keys: "Ctrl+Shift+P" }],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("pane-control-cwd-propagate-once").getAttribute("title")).toBe(
        "Propagate CWD once (Ctrl+Shift+P)",
      );
    });
  });

  // issue #324: 버튼은 우측 컨트롤 묶음이 아니라 좌측(pane 배지 우측)에 정렬된다.
  it("renders the propagate button on the left, right after the pane number badge (issue #324)", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
        paneNumber={2}
        workspaceId="ws-1"
        workspaceName="WS"
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const badge = screen.getByTestId("pane-number-badge");
    const btn = screen.getByTestId("pane-control-cwd-propagate-once");
    const viewSelect = screen.getByTestId("pane-control-view-select");
    // DOM 순서: 배지 → 전파 버튼 → (우측) 컨트롤 묶음(view select 등)
    expect(badge.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(btn.compareDocumentPosition(viewSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the propagate button on the left even without a pane number badge", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const btn = screen.getByTestId("pane-control-cwd-propagate-once");
    const viewSelect = screen.getByTestId("pane-control-view-select");
    expect(btn.compareDocumentPosition(viewSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("invokes onPropagateCwdOnce exactly once per click (one-shot)", async () => {
    const onPropagateCwdOnce = vi.fn();
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    await userEvent.click(screen.getByTestId("pane-control-cwd-propagate-once"));
    expect(onPropagateCwdOnce).toHaveBeenCalledTimes(1);
  });

  it("shows the propagate-CWD-once button for FileExplorerView too", () => {
    render(
      <PaneControlBar
        currentView={fileExplorerView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-propagate-once")).toBeInTheDocument();
  });

  it("hides the propagate-CWD-once button when no onPropagateCwdOnce action provided", () => {
    render(
      <PaneControlBar currentView={terminalView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-cwd-propagate-once")).not.toBeInTheDocument();
  });

  // -- Left icons grouped in one container (badge + propagate) --
  // 좌/우 아이콘 모두 바 오버레이(issue #320)를 그대로 따른다. 좌측은 별도 불투명 칩
  // 없이 배지+전파 버튼을 한 컨테이너로만 묶는다.

  it("groups left icons (badge + propagate) in one container", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={{ ...defaultActions, onPropagateCwdOnce: vi.fn() }}
        hovered={true}
        paneNumber={2}
        workspaceId="ws-1"
        workspaceName="WS"
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const container = screen.getByTestId("pane-control-bar-left-solid");
    // 배지와 전파 버튼이 모두 그 안에 들어있어야 한다.
    expect(container.contains(screen.getByTestId("pane-number-badge"))).toBe(true);
    expect(container.contains(screen.getByTestId("pane-control-cwd-propagate-once"))).toBe(true);
  });

  it("renders the left container even with only a badge (no propagate)", () => {
    render(
      <PaneControlBar
        currentView={terminalView}
        actions={defaultActions}
        hovered={true}
        paneNumber={3}
        workspaceId="ws-1"
        workspaceName="WS"
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const solid = screen.getByTestId("pane-control-bar-left-solid");
    expect(solid.contains(screen.getByTestId("pane-number-badge"))).toBe(true);
  });

  it("does not render the solid left container when there are no left icons", () => {
    render(
      <PaneControlBar currentView={terminalView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-bar-left-solid")).not.toBeInTheDocument();
  });
});
