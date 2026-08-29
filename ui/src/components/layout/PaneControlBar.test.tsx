import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { ViewHeader } from "@/components/ui/ViewHeader";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { useUiStore } from "@/stores/ui-store";

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

  it("vertically centers the default view label in the toolbar", () => {
    render(
      <PaneControlBar currentView={{ type: "MemoView" }} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByText("Memo", { selector: "span" }).className).toContain("ui-toolbar-title");
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

  it("터미널 실제 클리어 버튼은 단축키를 표시하고 전용 동작을 호출한다", async () => {
    const onClearTerminal = vi.fn();
    const user = userEvent.setup();
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onClearTerminal }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );

    const button = screen.getByTestId("pane-control-clear-terminal");
    expect(button).toHaveAttribute("title", "Clear terminal (Alt+L)");
    await user.click(button);
    expect(onClearTerminal).toHaveBeenCalledTimes(1);
  });

  it("터미널이 아닌 view에는 실제 클리어 버튼을 표시하지 않는다", () => {
    render(
      <PaneControlBar
        currentView={{ type: "MemoView" }}
        actions={{ ...defaultActions, onClearTerminal: vi.fn() }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );

    expect(screen.queryByTestId("pane-control-clear-terminal")).not.toBeInTheDocument();
  });

  it("Restart View는 terminal에서만 빨간 위험 버튼으로 표시하고 동작한다", async () => {
    const onRestart = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onRestart }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );

    const button = screen.getByTestId("pane-control-restart");
    expect(button).toHaveAttribute("title", "Restart view");
    expect(button.style.color).toBe("var(--red)");
    await user.click(button);
    expect(onRestart).toHaveBeenCalledTimes(1);

    rerender(
      <PaneControlBar
        currentView={{ type: "MemoView" }}
        actions={{ ...defaultActions, onRestart }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-restart")).not.toBeInTheDocument();
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

  it("keeps terminal clear available in the narrow hover menu", async () => {
    stubPaneWidth(320);
    const onClearTerminal = vi.fn();
    const user = userEvent.setup();
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onClearTerminal }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    await user.click(screen.getByTestId("pane-control-clear-terminal"));

    expect(onClearTerminal).toHaveBeenCalledTimes(1);
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

  it("moves overflowing ViewHeader controls to an automatic wrapped portal without resizing the body", async () => {
    // This pane is wider than the legacy 360px cutoff. Its GitHub-like header
    // still cannot keep the tabs intact beside the full control cluster.
    stubPaneWidth(480);
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "view-header-content" ? 120 : 480;
      });
    const scrollWidthSpy = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "view-header-content" ? 205 : 480;
      });

    const { container, rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader testId="view-header" title="GitHub">
          <button className="shrink-0">Issues 100</button>
          <button className="shrink-0">PRs 100</button>
        </ViewHeader>
        <div data-testid="view-body">body</div>
      </PaneControlBar>,
    );

    const menu = await screen.findByTestId("pane-control-floating-menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu).toHaveAttribute("role", "toolbar");
    expect(screen.getByTestId("pane-control-floating-content")).toHaveClass("flex-wrap");
    expect(screen.getByTestId("view-header")).toHaveClass("ui-toolbar");
    expect(screen.getByTestId("view-body")).toHaveTextContent("body");
    expect(screen.getByText("Issues 100")).toBeVisible();
    expect(screen.getByText("PRs 100")).toBeVisible();
    expect(menu).toContainElement(screen.getByTestId("pane-control-split-h"));
    expect(menu).toContainElement(screen.getByTestId("pane-control-split-v"));
    expect(menu).toContainElement(screen.getByTestId("pane-control-clear"));
    expect(menu).toContainElement(screen.getByTestId("pane-control-view-select"));
    expect(menu).toContainElement(screen.getByTestId("pane-control-pin"));
    expect(menu).toContainElement(screen.getByTestId("pane-control-minimize"));

    // Losing pane hover does not tear the portal down before the pointer can
    // cross into it. Once the pointer is outside both surfaces it closes.
    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <ViewHeader testId="view-header" title="GitHub">
          <button className="shrink-0">Issues 100</button>
          <button className="shrink-0">PRs 100</button>
        </ViewHeader>
        <div data-testid="view-body">body</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();
    // The fixed surface is separated from the pane by a small placement gap.
    // A real pointer briefly owns the underlying document while crossing it;
    // reaching the toolbar immediately afterward must cancel the pending close.
    fireEvent.pointerMove(document.body);
    fireEvent.pointerMove(screen.getByTestId("pane-control-floating-menu"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();
    fireEvent.pointerMove(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );

    clientWidthSpy.mockRestore();
    scrollWidthSpy.mockRestore();
  });

  it("closes an automatic hover toolbar after hover ownership idles without more pointer movement", async () => {
    stubPaneWidth(200);
    const { rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <ViewHeader title="GitHub">Issues 0</ViewHeader>
      </PaneControlBar>,
    );

    await screen.findByTestId("pane-control-floating-menu");
    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <ViewHeader title="GitHub">Issues 0</ViewHeader>
      </PaneControlBar>,
    );

    // Keep the pane-to-portal crossing grace, but do not leave an idle hover
    // surface stuck above the work area when no pointer event follows.
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
      { timeout: 500 },
    );
  });

  it("closes a focusless hover toolbar on Escape without consuming the key or stealing focus", async () => {
    stubPaneWidth(200);
    render(
      <div>
        <input data-testid="other-view-input" />
        <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
          <ViewHeader title="GitHub">Issues 0</ViewHeader>
        </PaneControlBar>
      </div>,
    );

    await screen.findByTestId("pane-control-floating-menu");
    const input = screen.getByTestId("other-view-input");
    input.focus();
    expect(input).toHaveFocus();

    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
    expect(input).toHaveFocus();
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

  it("closes an explicitly opened floating toolbar with Escape", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await user.click(await screen.findByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
  });

  it("moves focus into a manual toolbar and restores it to the trigger on Escape", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    const trigger = await screen.findByTestId("pane-control-menu-btn");
    await user.click(trigger);
    await waitFor(() => expect(screen.getByTestId("pane-control-view-select")).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("restores Escape focus to the owning pane when hover unmounts the trigger", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await user.click(await screen.findByTestId("pane-control-menu-btn"));
    await waitFor(() => expect(screen.getByTestId("pane-control-view-select")).toHaveFocus());

    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-menu-btn")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("pane-control-hover")).toHaveFocus();
  });

  it("preserves keyboard focus when a minimized narrow pane expands into the portal", async () => {
    stubPaneWidth(200);
    useSettingsStore.setState((state) => ({
      controlBar: { ...state.controlBar, defaultMode: "minimized" },
    }));
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    const minimizedTrigger = await screen.findByTestId("pane-control-menu-btn");
    minimizedTrigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("pane-control-view-select")).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("pane-control-menu-btn")).toHaveFocus();
  });

  it("discards a portalled menu while its owning workspace is inactive", async () => {
    stubPaneWidth(200);
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true} isActive>
        <div>content</div>
      </PaneControlBar>,
    );

    await user.click(await screen.findByTestId("pane-control-menu-btn"));
    expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument();

    rerender(
      <PaneControlBar
        currentView={defaultView}
        actions={defaultActions}
        hovered={false}
        isActive={false}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();

    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true} isActive>
        <div>content</div>
      </PaneControlBar>,
    );
    await screen.findByTestId("pane-control-menu-btn");
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();
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

  // -- Narrow floating menu placement --

  it("anchors the narrow menu to the trigger after a ViewHeader view takes over the bar", async () => {
    // Switching a narrow pane to a View that owns its header (UsageView,
    // CodexUsageView, …) briefly mounts two ⋯ triggers: the pane's own bar and
    // the ViewHeader's. When the pane bar then unmounts, its ref detach must not
    // wipe the still-mounted ViewHeader trigger — otherwise the menu falls back
    // to {top: 0, right: 0} and lands in the top-right corner of the app window.
    stubPaneWidth(200);
    useSettingsStore.setState((s) => ({
      controlBar: { ...s.controlBar, defaultMode: "pinned" },
    }));
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "pane-control-floating-menu") {
          return {
            top: 0,
            bottom: 50,
            left: 0,
            right: 200,
            width: 200,
            height: 50,
          } as DOMRect;
        }
        if (this.tagName === "BUTTON") {
          return {
            top: 100,
            bottom: 120,
            left: 380,
            right: 400,
            width: 20,
            height: 20,
          } as DOMRect;
        }
        return {
          top: 80,
          bottom: 600,
          left: 100,
          right: 420,
          width: 320,
          height: 520,
        } as DOMRect;
      });
    const user = userEvent.setup();
    const { rerender } = render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div>content</div>
      </PaneControlBar>,
    );
    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());

    rerender(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <ViewHeader testId="view-header" title="Codex Usage" />
      </PaneControlBar>,
    );
    await waitFor(() => expect(screen.getByTestId("view-header")).toBeInTheDocument());

    await user.click(screen.getByTestId("pane-control-menu-btn"));
    const menu = screen.getByTestId("pane-control-floating-menu");
    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "down"));
    expect(menu.style.top).toBe("122px");
    expect(menu.style.left).toBe("200px");
    rectSpy.mockRestore();
  });

  it("falls back to the pane's own top-right when the trigger cannot be measured", async () => {
    // A zero-sized rect means the trigger is not laid out (detached / clipped).
    // Anchoring to the pane keeps the menu next to its pane instead of jumping
    // to the app window corner.
    stubPaneWidth(200);
    const paneRect = {
      top: 300,
      bottom: 800,
      left: 40,
      right: 240,
      width: 200,
      height: 500,
    } as DOMRect;
    const zeroRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === "BUTTON") return zeroRect;
        if (this.dataset.testid === "pane-control-floating-menu") {
          return {
            top: 0,
            bottom: 50,
            left: 0,
            right: 180,
            width: 180,
            height: 50,
          } as DOMRect;
        }
        return paneRect;
      });
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));

    const menu = screen.getByTestId("pane-control-floating-menu");
    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "down"));
    expect(menu.style.top).toBe("302px");
    expect(menu.style.left).toBe("60px");
    rectSpy.mockRestore();
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

  it("keeps minimize available after expanding a narrow minimized pane", async () => {
    stubPaneWidth(320);
    const user = userEvent.setup();
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={true}>
        <div>content</div>
      </PaneControlBar>,
    );

    await waitFor(() => expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    await user.click(screen.getByTestId("pane-control-minimize"));
    expect(screen.getByTestId("pane-control-minimized")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-control-floating-menu")).not.toBeInTheDocument();

    // Expanding from the three-dot entry opens the same narrow menu. It must
    // retain a Minimize action so this is a reversible toggle.
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("pane-control-floating-menu")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("pane-control-minimize"));
    expect(screen.getByTestId("pane-control-minimized")).toBeInTheDocument();
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

  it("offers additional Codex account homes and selects their UsageView", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setCodexUsage({ configDirs: ["C:\\Users\\me\\.codex-work"] });
    const onChangeView = vi.fn();
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onChangeView }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const select = screen.getByTestId("pane-control-view-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toContain(
      "CodexUsageView:C:\\Users\\me\\.codex-work",
    );

    await user.selectOptions(select, "CodexUsageView:C:\\Users\\me\\.codex-work");
    expect(onChangeView).toHaveBeenCalledWith({
      type: "CodexUsageView",
      configDir: "C:\\Users\\me\\.codex-work",
    });
  });

  it("offers additional Grok homes and selects their UsageView", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      usage: {
        ...useSettingsStore.getState().usage,
        grok: {
          ...useSettingsStore.getState().usage.grok,
          configDirs: ["C:\\Users\\me\\.grok-work"],
        },
      },
    });
    const onChangeView = vi.fn();
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onChangeView }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const select = screen.getByTestId("pane-control-view-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toContain("GrokUsageView:");
    expect(Array.from(select.options).map((option) => option.value)).toContain(
      "GrokUsageView:C:\\Users\\me\\.grok-work",
    );

    await user.selectOptions(select, "GrokUsageView:C:\\Users\\me\\.grok-work");
    expect(onChangeView).toHaveBeenCalledWith({
      type: "GrokUsageView",
      configDir: "C:\\Users\\me\\.grok-work",
    });
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

  it("releases the view selector focus before committing a terminal profile change", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <PaneControlBar
        currentView={defaultView}
        actions={{ ...defaultActions, onChangeView }}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    const select = screen.getByTestId("pane-control-view-select") as HTMLSelectElement;
    select.focus();

    await user.selectOptions(select, "TerminalView:WSL");

    expect(select).not.toHaveFocus();
    expect(onChangeView).toHaveBeenCalledWith({ type: "TerminalView", profile: "WSL" });
  });

  it("renders children content in all modes", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div data-testid="child">content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("allows the content slot to shrink below a child's intrinsic width", () => {
    render(
      <PaneControlBar currentView={defaultView} actions={defaultActions} hovered={false}>
        <div data-testid="wide-child">content</div>
      </PaneControlBar>,
    );

    expect(screen.getByTestId("pane-control-hover")).toHaveClass("min-w-0", "overflow-hidden");
    expect(screen.getByTestId("wide-child").parentElement).toHaveClass(
      "min-w-0",
      "overflow-hidden",
    );
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

  it("offers GitHubView the receive toggle only — it follows a CWD but never sends one", () => {
    render(
      <PaneControlBar
        currentView={{ type: "GitHubView" as const }}
        actions={{
          ...defaultActions,
          onToggleCwdSend: vi.fn(),
          onToggleCwdReceive: vi.fn(),
          onPropagateCwdOnce: vi.fn(),
        }}
        cwdReceiveOn={true}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );
    expect(screen.getByTestId("pane-control-cwd-receive").getAttribute("title")).toBe(
      "CWD Receive (on)",
    );
    expect(screen.queryByTestId("pane-control-cwd-send")).toBeNull();
    expect(screen.queryByTestId("pane-control-cwd-propagate-once")).toBeNull();
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

  it("does not expose Remote spatial exclusion controls in the PC pane bar", () => {
    render(
      <PaneControlBar
        paneId="pane-workspace"
        currentView={terminalView}
        actions={defaultActions}
        hovered={true}
      >
        <div>content</div>
      </PaneControlBar>,
    );

    expect(screen.queryByTitle("Exclude this pane from pane navigation")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Include this pane in pane navigation")).not.toBeInTheDocument();
  });

  // -- workspace-list hide toggle (ADR-0035) --
  // pane 숨김은 보관함이 아니라 각 pane 컨트롤바의 이 토글로만 제어한다.
  describe("workspace-list hide toggle (ADR-0035)", () => {
    beforeEach(() => {
      useUiStore.setState(useUiStore.getInitialState());
    });

    it("toggles the pane's hidden raw state and reflects it on the button", async () => {
      const user = userEvent.setup();
      render(
        <PaneControlBar
          paneId="pane-x"
          currentView={terminalView}
          actions={defaultActions}
          hovered={true}
          showListHideToggle
        >
          <div>content</div>
        </PaneControlBar>,
      );
      const button = screen.getByTestId("pane-control-hide");
      expect(button).toHaveAttribute("title", "Hide from workspace list");

      await user.click(button);
      expect(useUiStore.getState().hiddenPaneIds.has("pane-x")).toBe(true);
      expect(screen.getByTestId("pane-control-hide")).toHaveAttribute(
        "title",
        "Show in workspace list",
      );

      await user.click(screen.getByTestId("pane-control-hide"));
      expect(useUiStore.getState().hiddenPaneIds.has("pane-x")).toBe(false);
    });

    it("does not render the toggle when showListHideToggle is off (e.g. dock panes)", () => {
      render(
        <PaneControlBar
          paneId="pane-x"
          currentView={terminalView}
          actions={defaultActions}
          hovered={true}
        >
          <div>content</div>
        </PaneControlBar>,
      );
      expect(screen.queryByTestId("pane-control-hide")).not.toBeInTheDocument();
    });
  });
});
