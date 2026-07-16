import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UndoSnackbar } from "./UndoSnackbar";

describe("UndoSnackbar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses after the default five-second lifetime", () => {
    const onDismiss = vi.fn();
    render(
      <UndoSnackbar message="Hidden" actionLabel="Undo" onAction={vi.fn()} onDismiss={onDismiss} />,
    );

    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("exposes a keyboard-focusable undo action", async () => {
    vi.useRealTimers();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <UndoSnackbar message="Hidden" actionLabel="Undo" onAction={onAction} onDismiss={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "Undo" });
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledOnce();
  });
});
