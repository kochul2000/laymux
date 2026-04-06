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
});
