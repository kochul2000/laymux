import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TwoClickConfirmButton } from "./TwoClickConfirmButton";

describe("TwoClickConfirmButton", () => {
  it("runs the action only on the second activation", () => {
    const onConfirm = vi.fn();
    render(
      <TwoClickConfirmButton confirmLabel="Click again to delete Extra" onConfirm={onConfirm}>
        Delete
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("data-confirming", "true");
    expect(button).toHaveAccessibleName("Click again to delete Extra");

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("runs on the first activation when confirmation is disabled", () => {
    const onConfirm = vi.fn();
    render(
      <TwoClickConfirmButton
        confirmationEnabled={false}
        confirmLabel="Click again"
        onConfirm={onConfirm}
      >
        Delete
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(button).not.toHaveAttribute("data-confirming");
  });

  it("discards an armed state when confirmation is disabled and re-enabled", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <TwoClickConfirmButton confirmLabel="Click again" onConfirm={onConfirm}>
        Delete
      </TwoClickConfirmButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    rerender(
      <TwoClickConfirmButton
        confirmationEnabled={false}
        confirmLabel="Click again"
        onConfirm={onConfirm}
      >
        Delete
      </TwoClickConfirmButton>,
    );
    rerender(
      <TwoClickConfirmButton confirmLabel="Click again" onConfirm={onConfirm}>
        Delete
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).not.toHaveAttribute("data-confirming");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("data-confirming", "true");
  });

  it("cancels confirmation when the pointer leaves", () => {
    const onConfirm = vi.fn();
    render(
      <TwoClickConfirmButton confirmLabel="Click again" onConfirm={onConfirm}>
        Close
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Close" });
    fireEvent.click(button);
    fireEvent.pointerLeave(button);
    expect(button).not.toHaveAttribute("data-confirming");

    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps confirmation armed across the synthetic leave after a touch tap", () => {
    const onConfirm = vi.fn();
    render(
      <TwoClickConfirmButton confirmLabel="Tap again" onConfirm={onConfirm}>
        Close
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Close" });
    const tap = () => {
      fireEvent.pointerDown(button, { pointerType: "touch" });
      fireEvent.pointerUp(button, { pointerType: "touch" });
      fireEvent.pointerOut(button, { pointerType: "touch" });
      fireEvent.pointerLeave(button, { pointerType: "touch" });
      fireEvent.click(button);
    };

    tap();
    expect(button).toHaveAttribute("data-confirming", "true");

    tap();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it.each(["blur", "Escape"])("cancels confirmation on %s", (cancelKind) => {
    const onConfirm = vi.fn();
    render(
      <TwoClickConfirmButton confirmLabel="Click again" onConfirm={onConfirm}>
        Hide
      </TwoClickConfirmButton>,
    );

    const button = screen.getByRole("button", { name: "Hide" });
    fireEvent.click(button);
    if (cancelKind === "blur") fireEvent.blur(button);
    else fireEvent.keyDown(button, { key: "Escape" });

    expect(button).not.toHaveAttribute("data-confirming");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
