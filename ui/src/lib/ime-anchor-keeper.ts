/**
 * Keeps the helper textarea at an anchor xterm keeps overwriting.
 *
 * Issue #532, review of PR #541. Positioning the helper once is not enough:
 * xterm's `CompositionHelper.updateCompositionElements()` writes
 * `textarea.style.left/top` from the **public buffer cursor** for as long as
 * `_isComposing` is true, once per render **and** again from a
 * `setTimeout(0)` it reschedules itself (pinned bundle):
 *
 * ```js
 * this._textarea.style.left = s + "px";   // s = buffer.x * cellWidth
 * this._textarea.style.top  = i + "px";   // i = buffer.y * cellHeight
 * ...
 * dontRecurse || setTimeout(() => this.updateCompositionElements(true), 0);
 * ```
 *
 * Measured against a real `Terminal`: after writing our anchor, xterm rewrote
 * the same properties and **its value was the one left standing**. A single
 * write is therefore a coin flip on whatever the OS reads last.
 *
 * This keeper wins that race without guessing at xterm's schedule: it watches
 * the `style` attribute and re-applies the desired offsets whenever they differ.
 * Comparing before writing means our own write does not re-trigger the observer,
 * so there is no feedback loop — and when the desired anchor is released the
 * observer stops, so nothing runs outside a diverged composition.
 *
 * The alternative — patching the pinned xterm bundle so
 * `updateCompositionElements` consults an anchor provider — removes the race
 * entirely but adds patch infrastructure and a per-upgrade cost. See ADR-0061.
 */

export type HelperAnchorOffsets = {
  left: number;
  top: number;
};

export type HelperAnchorKeeperTrace = (event: string, payload: Record<string, unknown>) => void;

export type HelperAnchorKeeper = {
  /**
   * Hold the helper at these offsets until `release`. Records the values xterm
   * had on the first call so `release` can put them back.
   */
  apply: (helper: HTMLTextAreaElement, offsets: HelperAnchorOffsets) => void;
  /** Stop holding and restore whatever xterm had before the first `apply`. */
  release: (reason: string) => void;
  /** True while an anchor is being held. */
  isHolding: () => boolean;
};

export type HelperAnchorKeeperOptions = {
  /**
   * Observer factory. Injected so the caller can pass a stub; defaults to the
   * global `MutationObserver`.
   */
  createObserver?: (callback: () => void) => {
    observe: (target: Element) => void;
    disconnect: () => void;
  };
  onTrace?: HelperAnchorKeeperTrace;
};

function defaultCreateObserver(callback: () => void) {
  const observer = new MutationObserver(() => callback());
  return {
    observe: (target: Element) =>
      observer.observe(target, { attributes: true, attributeFilter: ["style"] }),
    disconnect: () => observer.disconnect(),
  };
}

export function createHelperAnchorKeeper(
  options: HelperAnchorKeeperOptions = {},
): HelperAnchorKeeper {
  const trace: HelperAnchorKeeperTrace = (event, payload) => options.onTrace?.(event, payload);
  const createObserver = options.createObserver ?? defaultCreateObserver;

  let held: {
    helper: HTMLTextAreaElement;
    offsets: HelperAnchorOffsets;
    /** Inline values xterm had before we first moved it. */
    saved: { left: string; top: string };
    observer: { observe: (target: Element) => void; disconnect: () => void };
  } | null = null;

  /** Write only when the current value differs, so our own write is not a mutation. */
  const enforce = () => {
    if (!held) return;
    const nextLeft = `${held.offsets.left}px`;
    const nextTop = `${held.offsets.top}px`;
    if (held.helper.style.left === nextLeft && held.helper.style.top === nextTop) return;
    held.helper.style.left = nextLeft;
    held.helper.style.top = nextTop;
    trace("ime-anchor-reapplied", { left: held.offsets.left, top: held.offsets.top });
  };

  return {
    apply(helper, offsets) {
      if (held && held.helper !== helper) {
        // A different helper means the old one is gone; put it back first.
        this.release("helper-replaced");
      }
      if (!held) {
        held = {
          helper,
          offsets,
          saved: { left: helper.style.left, top: helper.style.top },
          observer: createObserver(() => enforce()),
        };
        held.observer.observe(helper);
        trace("ime-anchor-hold-started", { left: offsets.left, top: offsets.top });
      } else {
        held.offsets = offsets;
      }
      enforce();
    },

    release(reason) {
      if (!held) return;
      const { helper, saved, observer } = held;
      // Disconnect first: restoring is itself a style write, and re-enforcing it
      // would defeat the restore.
      observer.disconnect();
      held = null;
      helper.style.left = saved.left;
      helper.style.top = saved.top;
      trace("ime-anchor-restored", { reason });
    },

    isHolding() {
      return held !== null;
    },
  };
}
