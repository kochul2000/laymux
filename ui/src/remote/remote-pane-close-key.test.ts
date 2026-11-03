import { beforeEach, expect, it } from "vitest";
import { createPaneCloseKeyConfirmation } from "./remote-pane-controls.js";

beforeEach(() => document.body.replaceChildren());

function setup() {
  const button = document.createElement("button");
  button.title = "Close pane";
  button.setAttribute("aria-label", "Close pane");
  const other = document.createElement("button");
  document.body.append(button, other);
  const confirmation = createPaneCloseKeyConfirmation(document);
  const target = { id: "pane-a", canClose: true };
  return { button, other, confirmation, target };
}

it("requires two activations of the same key, pane and lease without stealing focus", () => {
  const { button, other, confirmation, target } = setup();
  other.focus();
  expect(confirmation.activate(button, target, "lease-1")).toBe(false);
  expect(button.dataset.confirming).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Click again to close pane");
  expect(document.activeElement).toBe(other);
  confirmation.update(target, "lease-1");
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch" }));
  expect(confirmation.activate(button, target, "lease-1")).toBe(true);
  expect(button.dataset.confirming).toBeUndefined();
  expect(button.title).toBe("Close pane");
});

it.each(["pointerdown", "click", "blur", "escape", "mouse", "pen", "windowBlur"])(
  "%s cancels confirmation",
  (kind) => {
    const { button, other, confirmation, target } = setup();
    confirmation.activate(button, target, "lease-1");
    if (kind === "pointerdown" || kind === "click") {
      other.dispatchEvent(new Event(kind, { bubbles: true }));
    } else if (kind === "escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    } else if (kind === "windowBlur") window.dispatchEvent(new Event("blur"));
    else if (kind === "blur") button.dispatchEvent(new Event("blur"));
    else button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: kind }));
    expect(button.dataset.confirming).toBeUndefined();
    expect(confirmation.activate(button, target, "lease-1")).toBe(false);
  },
);

it.each(["pane", "lease", "unavailable", "removed", "hidden", "disabled"])(
  "%s changes cancel confirmation before another activation",
  (kind) => {
    const { button, confirmation, target } = setup();
    confirmation.activate(button, target, "lease-1");
    if (kind === "removed") button.remove();
    if (kind === "hidden") button.hidden = true;
    if (kind === "disabled") button.disabled = true;
    confirmation.update(
      kind === "pane"
        ? { ...target, id: "pane-b" }
        : kind === "unavailable"
          ? { ...target, canClose: false }
          : target,
      kind === "lease" ? "lease-2" : "lease-1",
    );
    expect(button.dataset.confirming).toBeUndefined();
  },
);

it("another close button must start its own confirmation", () => {
  const { button, other, confirmation, target } = setup();
  confirmation.activate(button, target, "lease-1");
  expect(confirmation.activate(other, target, "lease-1")).toBe(false);
  expect(button.dataset.confirming).toBeUndefined();
  expect(other.dataset.confirming).toBe("true");
});

it("cannot arm without a closable pane and lease", () => {
  const { button, confirmation, target } = setup();
  expect(confirmation.activate(button, target, null)).toBe(false);
  expect(confirmation.activate(button, { ...target, canClose: false }, "lease-1")).toBe(false);
  expect(button.dataset.confirming).toBeUndefined();
});
