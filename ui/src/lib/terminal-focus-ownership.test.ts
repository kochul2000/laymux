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

/** Deferred microtask queue so tests model the end of the window-focus task. */
function createManualMicrotasks() {
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
      refreshActiveHelper: true,
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

  it("captures via focusout when the webview blanked focus before window blur", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    // This ordering reaches us first: focus goes nowhere, *then* window blur.
    helper.blur();
    ownership.noteFocusOut(helper, null);
    expect(document.activeElement).toBe(document.body);

    expect(ownership.captureOnAppBlur()).toBe(true);
    expect(ownership.getOwnedHelper()).toBe(helper);
    expect(ownership.reclaimOnAppFocus()).toBe(true);
    frames.runAll();
    expect(document.activeElement).toBe(helper);
  });

  it("does not capture a helper whose focusout handed focus to a real element", () => {
    const { container, helper } = buildPane();
    const composer = document.createElement("input");
    document.body.appendChild(composer);
    const ownership = createTerminalFocusOwnership({ getContainer: () => container });

    helper.focus();
    // Focus moved to a concrete element, so this pane owns nothing even if the
    // webview blanks focus afterwards.
    ownership.noteFocusOut(helper, composer);
    composer.focus();
    composer.blur();

    expect(ownership.captureOnAppBlur()).toBe(false);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("does not let another pane's focusout fallback win the reclaim", () => {
    const mine = buildPane();
    const other = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => mine.container,
      scheduleFrame: frames.schedule,
    });

    // Focus left this pane's helper for the other pane's helper, then the app
    // was deactivated with focus blanked. The fallback must not fire here.
    mine.helper.focus();
    ownership.noteFocusOut(mine.helper, other.helper);
    other.helper.focus();
    other.helper.blur();

    expect(ownership.captureOnAppBlur()).toBe(false);
    expect(ownership.reclaimOnAppFocus()).toBe(false);
    expect(frames.pending).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });

  it("drops the focusout fallback when a pointer press lands outside the surface", () => {
    const { container, helper } = buildPane();
    const sidebar = document.createElement("button");
    document.body.appendChild(sidebar);
    const ownership = createTerminalFocusOwnership({ getContainer: () => container });

    helper.focus();
    helper.blur();
    ownership.noteFocusOut(helper, null);
    ownership.releaseForPointerTarget(sidebar);

    expect(ownership.captureOnAppBlur()).toBe(false);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("still reclaims when the active element is the helper at window focus", () => {
    // The webview can report the helper as focused at window `focus` and blank
    // it immediately after, so the decision has to wait for the frame.
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      scheduleFrame: frames.schedule,
    });

    helper.focus();
    expect(ownership.captureOnAppBlur()).toBe(true);
    // Focus still reads as the helper here.
    expect(ownership.reclaimOnAppFocus()).toBe(true);
    expect(frames.pending).toBe(1);

    // ...and only then does the webview drop it.
    helper.blur();
    frames.runAll();
    expect(document.activeElement).toBe(helper);
  });

  it("refreshes the helper focus cycle when DOM focus never left during app deactivation", () => {
    // WebView2 can keep reporting the helper as `activeElement` while the
    // native IME/TSF context has detached from it. Calling focus() again is a
    // DOM no-op in that state, so the same pane click cannot recover input.
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });
    const focusEvents: string[] = [];

    helper.focus();
    helper.addEventListener("blur", () => focusEvents.push("blur"));
    helper.addEventListener("focus", () => focusEvents.push("focus"));

    expect(ownership.captureOnAppBlur()).toBe(true);
    expect(document.activeElement).toBe(helper);
    expect(ownership.reclaimOnAppFocus()).toBe(true);
    expect(frames.pending).toBe(0);
    microtasks.runAll();

    expect(focusEvents).toEqual(["blur", "focus"]);
    expect(document.activeElement).toBe(helper);
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaimed",
      expect.objectContaining({ refreshedActiveHelper: true }),
    );
  });

  it("routes a stale active helper through a relay before the next input task", () => {
    // A same-element blur/focus can complete while WebView2 keeps the stale TSF
    // document context. A different editable identity must own focus in between,
    // matching the observed other-pane-and-back recovery path.
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const relay = document.createElement("textarea");
    relay.tabIndex = -1;
    container.appendChild(relay);
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => relay,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
    });
    const focusEvents: string[] = [];

    helper.focus();
    helper.addEventListener("blur", () => focusEvents.push("helper-blur"));
    helper.addEventListener("focus", () => focusEvents.push("helper-focus"));
    relay.addEventListener("focus", () => focusEvents.push("relay-focus"));
    relay.addEventListener("blur", () => focusEvents.push("relay-blur"));
    expect(ownership.captureOnAppBlur()).toBe(true);
    expect(ownership.reclaimOnAppFocus()).toBe(true);
    expect(focusEvents).toEqual([]);
    expect(microtasks.pending).toBe(1);
    expect(frames.pending).toBe(0);

    // The stale context is repaired at the end of the window-focus task. A
    // physical key/composition event queued immediately after activation can
    // therefore no longer cancel the relay while waiting for the next frame.
    microtasks.runAll();
    ownership.releaseForHelperInput(helper);
    expect(focusEvents).toEqual(["helper-blur", "relay-focus", "relay-blur", "helper-focus"]);
    expect(document.activeElement).toBe(helper);
  });

  it("ignores helper input side effects caused by its own editable handoff", () => {
    const { container, helper } = buildPane();
    const relay = document.createElement("textarea");
    container.appendChild(relay);
    const microtasks = createManualMicrotasks();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => relay,
      scheduleMicrotask: microtasks.schedule,
    });
    const focusEvents: string[] = [];

    helper.focus();
    helper.addEventListener("blur", () => {
      focusEvents.push("helper-blur");
      // A native IME can commit composition while the controller blurs the
      // helper. TerminalView reports that resulting input synchronously.
      ownership.releaseForHelperInput(helper);
    });
    helper.addEventListener("focus", () => {
      focusEvents.push("helper-focus");
      ownership.releaseForHelperInput(helper);
    });
    relay.addEventListener("focus", () => focusEvents.push("relay-focus"));
    relay.addEventListener("blur", () => focusEvents.push("relay-blur"));

    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(focusEvents).toEqual(["helper-blur", "relay-focus", "relay-blur", "helper-focus"]);
    expect(document.activeElement).toBe(helper);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("cancels a stale refresh when synthetic helper input starts in the same task", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
    });
    const focusEvents: string[] = [];

    helper.focus();
    helper.addEventListener("blur", () => focusEvents.push("blur"));
    helper.addEventListener("focus", () => focusEvents.push("focus"));
    expect(ownership.captureOnAppBlur()).toBe(true);
    expect(ownership.reclaimOnAppFocus()).toBe(true);

    // A programmatic/nested event can still run before the current task reaches
    // its microtask checkpoint. Do not blur an input already in that stack.
    ownership.releaseForHelperInput(helper);
    microtasks.runAll();

    expect(focusEvents).toEqual([]);
    expect(document.activeElement).toBe(helper);
    expect(ownership.getOwnedHelper()).toBe(null);
  });

  it("does not steal focus when another element wins during the relay handoff", () => {
    const { container, helper } = buildPane();
    const relay = document.createElement("textarea");
    const modalInput = document.createElement("input");
    container.appendChild(relay);
    document.body.appendChild(modalInput);
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => relay,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    relay.addEventListener("blur", () => modalInput.focus());
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(document.activeElement).toBe(modalInput);
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaim-declined",
      expect.objectContaining({ reason: "focus-won-during-relay-blur" }),
    );
  });

  it("aborts when a relay focus handler invalidates the pane lifecycle", () => {
    const { container, helper } = buildPane();
    const relay = document.createElement("textarea");
    container.appendChild(relay);
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const focusEvents: string[] = [];
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => relay,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    helper.addEventListener("focus", () => focusEvents.push("helper-focus"));
    relay.addEventListener("focus", () => {
      focusEvents.push("relay-focus");
      ownership.clear("pane-unfocused");
    });
    relay.addEventListener("blur", () => focusEvents.push("relay-blur"));
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(focusEvents).toEqual(["relay-focus", "relay-blur"]);
    expect(document.activeElement).toBe(document.body);
    expect(onTrace).not.toHaveBeenCalledWith("focus-ownership-reclaimed", expect.anything());
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaim-declined",
      expect.objectContaining({ reason: "ownership-changed-during-relay-focus" }),
    );
  });

  it("aborts when the captured relay leaves the current surface during handoff", () => {
    const { container, helper } = buildPane();
    const relay = document.createElement("textarea");
    const nextContainer = document.createElement("div");
    const replacementRelay = document.createElement("textarea");
    container.appendChild(relay);
    nextContainer.appendChild(replacementRelay);
    document.body.appendChild(nextContainer);
    let currentContainer = container;
    let currentRelay = relay;
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => currentContainer,
      refreshActiveHelper: true,
      getFocusRelay: () => currentRelay,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    relay.addEventListener("focus", () => {
      nextContainer.appendChild(helper);
      currentContainer = nextContainer;
      currentRelay = replacementRelay;
    });
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(document.activeElement).toBe(document.body);
    expect(onTrace).not.toHaveBeenCalledWith("focus-ownership-reclaimed", expect.anything());
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaim-declined",
      expect.objectContaining({ reason: "ownership-changed-during-relay-focus" }),
    );
  });

  it("releases a helper whose final focus handler disposes the controller", () => {
    const { container, helper } = buildPane();
    const relay = document.createElement("textarea");
    container.appendChild(relay);
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => relay,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    helper.addEventListener("focus", () => ownership.dispose(), { once: true });
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(document.activeElement).toBe(document.body);
    expect(onTrace).not.toHaveBeenCalledWith("focus-ownership-reclaimed", expect.anything());
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaim-declined",
      expect.objectContaining({ reason: "ownership-changed-during-helper-focus" }),
    );
  });

  it("falls back to the helper when the relay cannot receive focus", () => {
    const { container, helper } = buildPane();
    const unfocusableRelay = document.createElement("textarea");
    vi.spyOn(unfocusableRelay, "focus").mockImplementation(() => undefined);
    container.appendChild(unfocusableRelay);
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      getFocusRelay: () => unfocusableRelay,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(document.activeElement).toBe(helper);
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-relay-skipped",
      expect.objectContaining({ reason: "relay-focus-failed" }),
    );
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaimed",
      expect.objectContaining({ usedFocusRelay: false }),
    );
  });

  it("keeps a DOM-active helper untouched when active refresh is disabled", () => {
    const { container, helper } = buildPane();
    const frames = createManualFrames();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: false,
      scheduleFrame: frames.schedule,
    });
    const focusEvents: string[] = [];

    helper.focus();
    helper.addEventListener("blur", () => focusEvents.push("blur"));
    helper.addEventListener("focus", () => focusEvents.push("focus"));
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    frames.runAll();

    expect(focusEvents).toEqual([]);
    expect(document.activeElement).toBe(helper);
  });

  it("does not steal focus when the refresh blur hands it to another element", () => {
    const { container, helper } = buildPane();
    const modalInput = document.createElement("input");
    document.body.appendChild(modalInput);
    const frames = createManualFrames();
    const microtasks = createManualMicrotasks();
    const onTrace = vi.fn();
    const ownership = createTerminalFocusOwnership({
      getContainer: () => container,
      refreshActiveHelper: true,
      scheduleFrame: frames.schedule,
      scheduleMicrotask: microtasks.schedule,
      onTrace,
    });

    helper.focus();
    helper.addEventListener("blur", () => modalInput.focus());
    ownership.captureOnAppBlur();
    ownership.reclaimOnAppFocus();
    microtasks.runAll();

    expect(document.activeElement).toBe(modalInput);
    expect(ownership.getOwnedHelper()).toBe(null);
    expect(onTrace).toHaveBeenCalledWith(
      "focus-ownership-reclaim-declined",
      expect.objectContaining({ reason: "focus-won-during-refresh" }),
    );
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
