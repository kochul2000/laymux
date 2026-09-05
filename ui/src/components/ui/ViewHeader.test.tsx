import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ViewHeader } from "./ViewHeader";
import {
  PaneControlContext,
  type PaneControlContextValue,
} from "@/components/layout/PaneControlContext";

function makeCtx(overrides: Partial<PaneControlContextValue> = {}): PaneControlContextValue {
  return {
    paneControls: <div data-testid="mock-pane-controls">controls</div>,
    mode: "hover",
    hovered: false,
    onSetMode: vi.fn(),
    registerHeader: vi.fn(),
    unregisterHeader: vi.fn(),
    ...overrides,
  };
}

function renderWithCtx(ctx: PaneControlContextValue, ui: React.ReactElement) {
  return render(<PaneControlContext.Provider value={ctx}>{ui}</PaneControlContext.Provider>);
}

describe("ViewHeader with PaneControlContext", () => {
  it("calls registerHeader on mount and unregisterHeader on unmount", () => {
    const ctx = makeCtx();
    const { unmount } = renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    expect(ctx.registerHeader).toHaveBeenCalledOnce();
    unmount();
    expect(ctx.unregisterHeader).toHaveBeenCalledOnce();
  });

  it("shows pane controls when pinned", () => {
    const ctx = makeCtx({ mode: "pinned" });
    renderWithCtx(ctx, <ViewHeader testId="header">Title</ViewHeader>);
    expect(screen.getByTestId("mock-pane-controls")).toBeInTheDocument();
  });

  it("shows pane controls when hover + hovered", () => {
    const ctx = makeCtx({ mode: "hover", hovered: true });
    renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    expect(screen.getByTestId("mock-pane-controls")).toBeInTheDocument();
  });

  it("hides pane controls when hover + not hovered", () => {
    const ctx = makeCtx({ mode: "hover", hovered: false });
    renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    expect(screen.queryByTestId("mock-pane-controls")).not.toBeInTheDocument();
  });

  it("shows minimized button when minimized + hovered", () => {
    const ctx = makeCtx({ mode: "minimized", hovered: true });
    renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    expect(screen.getByTestId("pane-control-menu-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-pane-controls")).not.toBeInTheDocument();
  });

  it("hides minimized button when minimized + not hovered", () => {
    const ctx = makeCtx({ mode: "minimized", hovered: false });
    renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    expect(screen.queryByTestId("pane-control-menu-btn")).not.toBeInTheDocument();
  });

  it("clicking minimized button calls onSetMode('hover')", async () => {
    const user = userEvent.setup();
    const ctx = makeCtx({ mode: "minimized", hovered: true });
    renderWithCtx(ctx, <ViewHeader>Title</ViewHeader>);
    await user.click(screen.getByTestId("pane-control-menu-btn"));
    expect(ctx.onSetMode).toHaveBeenCalledWith("hover");
  });

  it("releases its toolbar height when minimized", () => {
    const ctx = makeCtx({ mode: "minimized", hovered: false });
    renderWithCtx(ctx, <ViewHeader testId="header">My View Title</ViewHeader>);
    expect(screen.getByTestId("header")).not.toHaveClass("ui-toolbar");
    expect(screen.queryByText("My View Title")).not.toBeInTheDocument();
  });

  it("vertically centers a title prop in the toolbar", () => {
    const ctx = makeCtx();
    renderWithCtx(ctx, <ViewHeader title="Memo" />);
    expect(screen.getByText("Memo").className).toContain("ui-toolbar-title");
  });

  // issue #324: 좌측(배지 우측) 컨트롤 — propagate CWD once 버튼이 여기로 주입된다.
  it("renders leftPaneControls next to the badge when controls are shown (issue #324)", () => {
    const ctx = makeCtx({
      mode: "pinned",
      paneNumber: 1,
      leftPaneControls: <button data-testid="mock-left-controls">L</button>,
    });
    renderWithCtx(ctx, <ViewHeader title="term">x</ViewHeader>);
    const badge = screen.getByTestId("pane-number-badge");
    const left = screen.getByTestId("mock-left-controls");
    const right = screen.getByTestId("mock-pane-controls");
    expect(badge.compareDocumentPosition(left) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides leftPaneControls when pane controls are hidden (hover + not hovered)", () => {
    const ctx = makeCtx({
      mode: "hover",
      hovered: false,
      leftPaneControls: <button data-testid="mock-left-controls">L</button>,
    });
    renderWithCtx(ctx, <ViewHeader title="term">x</ViewHeader>);
    expect(screen.queryByTestId("mock-left-controls")).not.toBeInTheDocument();
  });

  it("renders the pane number badge when paneNumber is set", () => {
    const ctx = makeCtx({ paneNumber: 2 });
    renderWithCtx(ctx, <ViewHeader title="term">x</ViewHeader>);
    expect(screen.getByTestId("pane-number-badge")).toHaveTextContent("2");
  });

  it("does not render the badge when paneNumber is undefined", () => {
    const ctx = makeCtx();
    renderWithCtx(ctx, <ViewHeader title="term">x</ViewHeader>);
    expect(screen.queryByTestId("pane-number-badge")).not.toBeInTheDocument();
  });

  it("reports an inline collision from actual content overflow instead of a pane-width cutoff", async () => {
    const reportHeaderControlsOverflow = vi.fn();
    let rootWidth = 480;
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    const originalScrollWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "view-header-content" ? 120 : rootWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "view-header-content" ? 190 : rootWidth;
      },
    });

    const ctx = makeCtx({
      mode: "hover",
      hovered: true,
      reportHeaderControlsOverflow,
    });
    const header = (
      <ViewHeader testId="header" title="GitHub">
        <button className="shrink-0">Issues 100</button>
        <button className="shrink-0">PRs 100</button>
      </ViewHeader>
    );
    const { rerender, unmount } = renderWithCtx(ctx, header);

    await waitFor(() => expect(reportHeaderControlsOverflow).toHaveBeenCalledWith(true));

    // The failed inline requirement is retained while controls are compact,
    // then released once the header really grows past that requirement.
    reportHeaderControlsOverflow.mockClear();
    rootWidth = 600;
    rerender(
      <PaneControlContext.Provider value={{ ...ctx, floatingControls: true }}>
        {header}
      </PaneControlContext.Provider>,
    );
    await waitFor(() => expect(reportHeaderControlsOverflow).toHaveBeenCalledWith(false));
    unmount();
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
    if (originalScrollWidth) {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", originalScrollWidth);
    } else {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });

  it("remeasures inline overflow when asynchronous header content changes at the same box size", async () => {
    const reportHeaderControlsOverflow = vi.fn();
    const originalResizeObserver = globalThis.ResizeObserver;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let contentScrollWidth = 120;
    const clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "view-header-content" ? 120 : 480;
      });
    const scrollWidthSpy = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "view-header-content" ? contentScrollWidth : 480;
      });
    const ctx = makeCtx({
      mode: "hover",
      hovered: true,
      reportHeaderControlsOverflow,
    });

    try {
      const { rerender } = renderWithCtx(
        ctx,
        <ViewHeader title="GitHub">
          <button className="shrink-0">Issues 0</button>
        </ViewHeader>,
      );
      await waitFor(() => expect(reportHeaderControlsOverflow).toHaveBeenCalledWith(false));

      reportHeaderControlsOverflow.mockClear();
      contentScrollWidth = 200;
      rerender(
        <PaneControlContext.Provider value={ctx}>
          <ViewHeader title="GitHub">
            <button className="shrink-0">Issues 100</button>
          </ViewHeader>
        </PaneControlContext.Provider>,
      );

      await waitFor(() => expect(reportHeaderControlsOverflow).toHaveBeenCalledWith(true));
    } finally {
      clientWidthSpy.mockRestore();
      scrollWidthSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("keeps floating hover controls closed while keeping the header one row high", async () => {
    const openControls = vi.fn();
    const ctx = makeCtx({
      mode: "hover",
      hovered: true,
      floatingControls: true,
      openControls,
    });
    renderWithCtx(ctx, <ViewHeader testId="header">GitHub</ViewHeader>);

    expect(openControls).not.toHaveBeenCalled();
    expect(screen.getByTestId("header")).toHaveClass("ui-toolbar");
    expect(screen.getByTestId("mock-pane-controls")).toBeInTheDocument();
  });

  it("does not auto-open floating pinned controls", async () => {
    const openControls = vi.fn();
    const ctx = makeCtx({
      mode: "pinned",
      hovered: false,
      floatingControls: true,
      openControls,
    });
    renderWithCtx(ctx, <ViewHeader>GitHub</ViewHeader>);

    expect(openControls).not.toHaveBeenCalled();
  });
});
