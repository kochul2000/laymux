import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHelperAnchorKeeper } from "./ime-anchor-keeper";

function stubMatchMedia() {
  if (window.matchMedia) return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

const mounted: Terminal[] = [];

/** Real xterm, because the second style writer only exists in the real one. */
function mountTerminal() {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 25 });
  terminal.open(host);
  mounted.push(terminal);
  const helper = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
  return { terminal, helper };
}

function startComposition(helper: HTMLTextAreaElement) {
  helper.focus();
  helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  helper.value = "가";
  helper.selectionStart = 1;
  helper.selectionEnd = 1;
  helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

afterEach(() => {
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("xterm overwrites the helper position during composition (baseline)", () => {
  it("wins a single unguarded write", async () => {
    // The defect the mock-based tests cannot see: `CompositionHelper`
    // .updateCompositionElements writes style.left/top from the public buffer
    // cursor on every render and again from a self-rescheduled setTimeout(0).
    const { helper } = mountTerminal();
    startComposition(helper);

    helper.style.left = "123px";
    helper.style.top = "456px";
    await settle();

    // xterm's value is the one left standing.
    expect(helper.style.left).not.toBe("123px");
    expect(helper.style.top).not.toBe("456px");
  });
});

describe("createHelperAnchorKeeper", () => {
  it("keeps the anchor even though xterm rewrites the same properties", async () => {
    const { helper } = mountTerminal();
    startComposition(helper);

    const keeper = createHelperAnchorKeeper();
    keeper.apply(helper, { left: 123, top: 456 });
    await settle();

    expect(helper.style.left).toBe("123px");
    expect(helper.style.top).toBe("456px");
    expect(keeper.isHolding()).toBe(true);
  });

  it("restores what xterm had once released", async () => {
    const { helper } = mountTerminal();
    startComposition(helper);
    await settle();
    const before = { left: helper.style.left, top: helper.style.top };

    const keeper = createHelperAnchorKeeper();
    keeper.apply(helper, { left: 123, top: 456 });
    await settle();
    expect(helper.style.left).toBe("123px");

    keeper.release("composition-end");
    expect(keeper.isHolding()).toBe(false);
    expect(helper.style.left).toBe(before.left);
    expect(helper.style.top).toBe(before.top);

    // And it stays released — no re-enforcement after disconnect.
    await settle();
    expect(helper.style.left).not.toBe("123px");
  });

  it("follows a moved anchor without re-recording the saved values", async () => {
    const { helper } = mountTerminal();
    startComposition(helper);
    await settle();
    const before = { left: helper.style.left, top: helper.style.top };

    const keeper = createHelperAnchorKeeper();
    keeper.apply(helper, { left: 10, top: 20 });
    await settle();
    keeper.apply(helper, { left: 30, top: 40 });
    await settle();
    expect(helper.style.left).toBe("30px");

    keeper.release("done");
    // Saved values are still xterm's originals, not the first anchor.
    expect(helper.style.left).toBe(before.left);
    expect(helper.style.top).toBe(before.top);
  });

  it("does not write when the anchor already matches", () => {
    const helper = document.createElement("textarea");
    document.body.appendChild(helper);
    helper.style.left = "5px";
    helper.style.top = "7px";

    const traces: string[] = [];
    const keeper = createHelperAnchorKeeper({ onTrace: (event) => traces.push(event) });
    keeper.apply(helper, { left: 5, top: 7 });

    // Held, but no re-apply — the values were already right.
    expect(traces).toEqual(["ime-anchor-hold-started"]);
    keeper.release("done");
  });

  it("hands over cleanly when the helper is replaced", () => {
    const first = document.createElement("textarea");
    const second = document.createElement("textarea");
    document.body.append(first, second);
    first.style.left = "1px";
    first.style.top = "2px";

    const keeper = createHelperAnchorKeeper();
    keeper.apply(first, { left: 10, top: 20 });
    expect(first.style.left).toBe("10px");

    keeper.apply(second, { left: 30, top: 40 });
    // The old helper is back to its own values...
    expect(first.style.left).toBe("1px");
    expect(first.style.top).toBe("2px");
    // ...and the new one is held.
    expect(second.style.left).toBe("30px");
    keeper.release("done");
  });

  it("release is idempotent", () => {
    const helper = document.createElement("textarea");
    document.body.appendChild(helper);
    const keeper = createHelperAnchorKeeper();
    keeper.release("never-applied");
    keeper.apply(helper, { left: 1, top: 2 });
    keeper.release("first");
    keeper.release("second");
    expect(keeper.isHolding()).toBe(false);
  });

  it("disconnects the observer on release", () => {
    const helper = document.createElement("textarea");
    document.body.appendChild(helper);
    const disconnect = vi.fn();
    const observe = vi.fn();
    const keeper = createHelperAnchorKeeper({
      createObserver: () => ({ observe, disconnect }),
    });

    keeper.apply(helper, { left: 1, top: 2 });
    expect(observe).toHaveBeenCalledWith(helper);
    keeper.release("done");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
