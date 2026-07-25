import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTerminalFocusOwnership,
  findActiveHelperTextarea,
  isUnownedActiveElement,
  isXtermHelperTextarea,
} from "./terminal-focus-ownership";

function buildPane(): {
  container: HTMLDivElement;
  helper: HTMLTextAreaElement;
} {
  const container = document.createElement("div");
  const host = document.createElement("div");
  const helper = document.createElement("textarea");
  helper.className = "xterm-helper-textarea";
  host.appendChild(helper);
  container.appendChild(host);
  document.body.appendChild(container);
  return { container, helper };
}

/** Deferred frame queue so tests control when the reclaim frame runs. */
function createManualFrames() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
    },
    runAll: () => {
      const pending = queue.splice(0, queue.length);
      for (const cb of pending) cb();
    },
    get pending() {
      return queue.length;
    },
  };
}

describe("terminal-focus-ownership predicates", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("recognizes only the xterm helper textarea", () => {
    const { helper } = buildPane();
    const other = document.createElement("textarea");
    document.body.appendChild(other);
    expect(isXtermHelperTextarea(helper)).toBe(true);
    expect(isXtermHelperTextarea(other)).toBe(false);
    expect(isXtermHelperTextarea(null)).toBe(false);
  });

  it("treats null / body / documentElement as unowned focus", () => {
    expect(isUnownedActiveElement(null, document)).toBe(true);
    expect(isUnownedActiveElement(document.body, document)).toBe(true);
    expect(isUnownedActiveElement(document.documentElement, document)).toBe(true);
    const { helper } = buildPane();
    expect(isUnownedActiveElement(helper, document)).toBe(false);
  });

  it("only reports a helper that this pane's container owns", () => {
    const mine = buildPane();
    const other = buildPane();
    expect(findActiveHelperTextarea(mine.container, mine.helper)).toBe(mine.helper);
    expect(findActiveHelperTextarea(mine.container, other.helper)).toBe(null);
    expect(findActiveHelperTextarea(mine.container, document.body)).toBe(null);
  });
});

describe("createTerminalFocusOwnership", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("restores the helper that owned focus at app blur when focus fell to body", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    expect(document.activeElement).toBe(helper);

    // Alt-Tab: the app loses focus and the webview drops DOM focus to body.
    expect(ownership.captureOnAppBlur()).toBe(true);
    helper.blur();
    expect(document.activeElement).toBe(document.body);

    expect(ownership.reclaimOnAppFocus()).toBe(true);
    // Nothing is stolen before the next frame.
    expect(document.activeElement).toBe(document.body);
    frames.runAll();
    expect(document.activeElement).toBe(helper);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("restores the exact helper of this pane in a multi-pane document", () => {
    const first = buildPane();
    const second = buildPane();
    const frames = createManualFrames();
    const secondOwnership = createTerminalFocusOwnership({
      getContainer: () => second.container,
      scheduleFrame: frames.schedule,
    });
    const firstOwnership = createTerminalFocusOwnership({
      getContainer: () => first.container,
      scheduleFrame: frames.schedule,
    });

    second.helper.focus();
    // Both panes observe the same window blur; only the owner captures.
    expect(firstOwnership.captureOnAppBlur()).toBe(false);
    expect(secondOwnership.captureOnAppBlur()).toBe(true);
    second.helper.blur();

    firstOwnership.reclaimOnAppFocus();
    secondOwnership.reclaimOnAppFocus();
    frames.runAll();

    expect(document.activeElement).toBe(second.helper);
  });

  it("does not capture when focus sits outside the terminal surface", () => {
    const { container, helper } = buildPane();
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    const ownership = createTerminalFocusOwnership({ getContainer: () => container });

    outside.focus();
    expect(ownership.captureOnAppBlur()).toBe(false);
    expect(ownership.getOwnedHelper()).toBe(null);
    expect(helper.ownerDocument.activeElement).toBe(outside);
  });

  it("declines the reclaim when another element already owns focus on return", () => {
    const { container, helper } = buildPane();
    const modalInput = document.createElement("input");
    document.body.appendChild(modalInput);
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();

    // A modal grabbed focus while the app was reactivating.
    modalInput.focus();
    expect(ownership.reclaimOnAppFocus()).toBe(false);
    expect(frames.pending).toBe(0);
    expect(document.activeElement).toBe(modalInput);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("does not steal focus when another element wins during the reclaim frame", () => {
    const { container, helper } = buildPane();
    const searchInput = document.createElement("input");
    document.body.appendChild(searchInput);
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    expect(ownership.reclaimOnAppFocus()).toBe(true);

    // Focus lands on a search box between the focus event and the frame.
    searchInput.focus();
    frames.runAll();

    expect(document.activeElement).toBe(searchInput);
  });

  it("drops ownership when a pointer press hands focus outside the surface", () => {
    const { container, helper } = buildPane();
    const sidebarButton = document.createElement("button");
    document.body.appendChild(sidebarButton);
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    ownership.reclaimOnAppFocus();

    // Re-activating click landed on the sidebar, which does not take DOM focus.
    ownership.releaseForPointerTarget(sidebarButton);
    frames.runAll();

    expect(document.activeElement).toBe(document.body);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("keeps ownership when the pointer press stays inside the surface", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    ownership.reclaimOnAppFocus();
    ownership.releaseForPointerTarget(container.firstElementChild);
    frames.runAll();

    expect(document.activeElement).toBe(helper);
  });

  it("drops ownership when xterm replaces the helper textarea", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();

    const replacement = document.createElement("textarea");
    replacement.className = "xterm-helper-textarea";
    helper.replaceWith(replacement);
    ownership.notifyHelperBound(replacement);

    expect(ownership.reclaimOnAppFocus()).toBe(false);
    expect(frames.pending).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });

  it("declines the reclaim when the remembered helper left the DOM (unmount)", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    container.remove();

    expect(ownership.reclaimOnAppFocus()).toBe(false);
    expect(ownership.getOwnedHelper()).toBe(null);
    expect(frames.pending).toBe(0);
  });

  it("clears ownership on explicit clear and on dispose", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    // e.g. pane focus moved to another pane while the app was inactive.
    ownership.clear("pane-unfocused");
    expect(ownership.getOwnedHelper()).toBe(null);
    expect(ownership.reclaimOnAppFocus()).toBe(false);

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    ownership.reclaimOnAppFocus();
    ownership.dispose();
    frames.runAll();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not re-enter the terminal after repeated blur/focus without helper focus", () => {
    const { container } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    for (let i = 0; i < 3; i += 1) {
      expect(ownership.captureOnAppBlur()).toBe(false);
      expect(ownership.reclaimOnAppFocus()).toBe(false);
    }
    frames.runAll();
    expect(document.activeElement).toBe(document.body);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("traces the activeElement transition around app blur and focus", () => {
    const { container, helper } = buildPane();
    helper.id = "helper-1";
    const frames = createManualFrames();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
      onTrace,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.blur();
    ownership.reclaimOnAppFocus();
    frames.runAll();

    const events = onTrace.mock.calls.map(([event]) => event);
    expect(events).toContain("focus-ownership-captured");
    expect(events).toContain("focus-ownership-reclaim-scheduled");
    expect(events).toContain("focus-ownership-reclaimed");
    const scheduled = onTrace.mock.calls.find(
      ([event]) => event === "focus-ownership-reclaim-scheduled",
    );
    expect(scheduled?.[1]).toMatchObject({ activeElement: "body" });
  });
});
