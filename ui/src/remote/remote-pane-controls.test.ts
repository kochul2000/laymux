import { beforeEach, expect, it, vi } from "vitest";
import { createPaneControls, installWorkspaceRenameGesture } from "./remote-pane-controls.js";

beforeEach(() => document.body.replaceChildren());

function setup() {
  const hideButton = document.createElement("button");
  const closeButton = document.createElement("button");
  document.body.append(hideButton, closeButton);
  const hide = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const controls = createPaneControls({ hideButton, closeButton, hide, close, onError });
  controls.update({ id: "pane-a", canHide: true, canClose: true, hidden: false }, "lease-1");
  return { controls, hideButton, closeButton, hide, close, onError };
}

it("arms visually then closes the same pane with no dialog or extra text", async () => {
  const { closeButton, close } = setup();
  closeButton.click();
  expect(close).not.toHaveBeenCalled();
  expect(closeButton.dataset.confirming).toBe("true");
  expect(closeButton.textContent).toBe("");
  closeButton.click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith("pane-a", "lease-1"));
  expect(closeButton.disabled).toBe(true);
});

it.each(["blur", "escape", "mouse", "pen"])("%s cancels confirmation", (kind) => {
  const { closeButton, close } = setup();
  closeButton.click();
  if (kind === "escape") closeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  else if (kind === "blur") closeButton.dispatchEvent(new Event("blur"));
  else {
    const event = new Event("pointerleave");
    Object.defineProperty(event, "pointerType", { value: kind });
    closeButton.dispatchEvent(event);
  }
  closeButton.click();
  expect(close).not.toHaveBeenCalled();
});

it("touch pointerleave and ordinary navigation refresh preserve arming", () => {
  const { controls, closeButton, close } = setup();
  closeButton.click();
  const event = new Event("pointerleave");
  Object.defineProperty(event, "pointerType", { value: "touch" });
  closeButton.dispatchEvent(event);
  controls.update({ id: "pane-a", canHide: true, canClose: true, hidden: false }, "lease-1");
  closeButton.click();
  expect(close).toHaveBeenCalledExactlyOnceWith("pane-a", "lease-1");
});

it.each(["target", "lease"])("%s changes cancel confirmation", (kind) => {
  const { controls, closeButton, close } = setup();
  closeButton.click();
  controls.update(
    { id: kind === "target" ? "pane-b" : "pane-a", canHide: true, canClose: true, hidden: false },
    kind === "lease" ? "lease-2" : "lease-1",
  );
  closeButton.click();
  expect(close).not.toHaveBeenCalled();
});

it("disables controls without a lease and omits unsupported operations", () => {
  const { controls, hideButton, closeButton, close } = setup();
  controls.update({ id: "pane-a", canHide: false, canClose: false, hidden: false }, null);
  expect(hideButton.hidden).toBe(true);
  expect(closeButton.hidden).toBe(true);
  closeButton.click();
  expect(close).not.toHaveBeenCalled();
});

it("toggles selector visibility without closing the pane", () => {
  const { hideButton, hide, close } = setup();
  hideButton.click();
  expect(hide).toHaveBeenCalledExactlyOnceWith("pane-a", true, "lease-1");
  expect(close).not.toHaveBeenCalled();
});

it("reports failure, disarms and allows a fresh two-click retry", async () => {
  const { closeButton, close, onError } = setup();
  close.mockRejectedValueOnce(new Error("close refused"));
  closeButton.click();
  closeButton.click();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(closeButton.disabled).toBe(false);
  expect(closeButton.dataset.confirming).toBeUndefined();
  closeButton.click();
  expect(close).toHaveBeenCalledTimes(1);
});

it("workspace long press enters rename and suppresses the workspace switch click", () => {
  vi.useFakeTimers();
  try {
    const row = document.createElement("div");
    document.body.append(row);
    const rename = vi.fn();
    const switchWorkspace = vi.fn();
    installWorkspaceRenameGesture(row, rename);
    row.addEventListener("click", switchWorkspace);
    const event = new Event("pointerdown", { bubbles: true });
    Object.assign(event, { button: 0, clientX: 20, clientY: 30 });
    row.dispatchEvent(event);
    vi.advanceTimersByTime(450);
    row.dispatchEvent(new Event("pointerup"));
    row.click();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(switchWorkspace).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("navigation refresh discards the old row's pending rename gesture", () => {
  vi.useFakeTimers();
  try {
    const row = document.createElement("div");
    document.body.append(row);
    const rename = vi.fn();
    installWorkspaceRenameGesture(row, rename);
    const event = new Event("pointerdown", { bubbles: true });
    Object.assign(event, { button: 0, clientX: 20, clientY: 30 });
    row.dispatchEvent(event);
    vi.advanceTimersByTime(200);
    row.replaceWith(document.createElement("div"));
    vi.advanceTimersByTime(250);
    expect(rename).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("scroll movement and action-button presses do not start workspace rename", () => {
  vi.useFakeTimers();
  try {
    const row = document.createElement("div");
    const button = document.createElement("button");
    row.append(button);
    document.body.append(row);
    const rename = vi.fn();
    installWorkspaceRenameGesture(row, rename);
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { button: 0, clientX: x, clientY: y });
      return event;
    };
    row.dispatchEvent(pointer("pointerdown", 20, 30));
    row.dispatchEvent(pointer("pointermove", 20, 42));
    vi.advanceTimersByTime(450);
    button.dispatchEvent(pointer("pointerdown", 20, 30));
    vi.advanceTimersByTime(450);
    expect(rename).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
