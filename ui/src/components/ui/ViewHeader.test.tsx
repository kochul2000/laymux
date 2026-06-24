import { render, screen } from "@testing-library/react";
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

  it("always renders view content regardless of mode", () => {
    const ctx = makeCtx({ mode: "minimized", hovered: false });
    renderWithCtx(ctx, <ViewHeader>My View Title</ViewHeader>);
    expect(screen.getByText("My View Title")).toBeInTheDocument();
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
});
