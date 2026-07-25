/**
 * xterm helper textarea DOM focus ownership across app (window) blur/focus.
 *
 * Issue #530. Pane focus lives in the store and stays the single source of
 * truth for *which* pane is focused; this module owns only the narrow question
 * of **which DOM element** holds keyboard focus while the OS window is
 * inactive. When the app is deactivated (Alt-Tab, clicking another window) the
 * webview can drop the real DOM focus of the xterm helper textarea to
 * `body`/`null`. Pane focus in the store is unchanged, so no React effect
 * re-runs on reactivation and the helper never regains DOM focus — the first
 * key or the first IME composition after coming back is swallowed or lands in
 * another pane.
 *
 * Invariants (see ADR-0057):
 * - Ownership is recorded **only** when the pane's own helper textarea really
 *   held DOM focus at window blur. Store focus alone never records ownership.
 * - Restoration happens one frame after window focus and **only** when the
 *   active element is still `body`/`null`/`documentElement`. Any element that
 *   won focus in between (modal, search box, settings input, another pane's
 *   helper) keeps it — focus is never stolen back.
 * - The record is dropped as soon as it can no longer be trusted: helper
 *   detached or replaced, container gone, pointer press handed focus outside
 *   the surface, pane unfocused/unmounted, controller disposed.
 * - No global "focus the terminal on app activation" call exists; each pane
 *   restores at most its own remembered helper.
 */

export type FocusOwnershipTrace = (event: string, payload: Record<string, unknown>) => void;

export type TerminalFocusOwnershipOptions = {
  /** The pane surface that must contain the helper for it to be owned. */
  getContainer: () => HTMLElement | null;
  /** Frame scheduler. Defaults to `requestAnimationFrame` (setTimeout fallback). */
  scheduleFrame?: (callback: () => void) => void;
  onTrace?: FocusOwnershipTrace;
};

export type TerminalFocusOwnership = {
  /** Window blur: remember this pane's helper if it currently owns DOM focus. */
  captureOnAppBlur: () => boolean;
  /** Window focus: schedule a next-frame restore of the remembered helper. */
  reclaimOnAppFocus: () => boolean;
  /** Pointer press anywhere: a press outside the surface hands focus away. */
  releaseForPointerTarget: (target: EventTarget | null) => void;
  /** xterm adopted a (possibly new) helper textarea — invalidate stale records. */
  notifyHelperBound: (helper: HTMLTextAreaElement | null) => void;
  clear: (reason: string) => void;
  getOwnedHelper: () => HTMLTextAreaElement | null;
  dispose: () => void;
};

export function isXtermHelperTextarea(target: unknown): target is HTMLTextAreaElement {
  return (
    typeof HTMLTextAreaElement !== "undefined" &&
    target instanceof HTMLTextAreaElement &&
    target.classList.contains("xterm-helper-textarea")
  );
}

/**
 * True when nothing meaningful holds focus: `null`, `body`, or the root
 * element. Only in that state may a remembered helper be restored.
 */
export function isUnownedActiveElement(
  activeElement: Element | null,
  ownerDocument: Document | null,
): boolean {
  if (!activeElement) return true;
  if (!ownerDocument) return false;
  return activeElement === ownerDocument.body || activeElement === ownerDocument.documentElement;
}

/** The active element, but only when it is a helper textarea this pane owns. */
export function findActiveHelperTextarea(
  container: HTMLElement | null,
  activeElement: Element | null,
): HTMLTextAreaElement | null {
  if (!container || !isXtermHelperTextarea(activeElement)) return null;
  return container.contains(activeElement) ? activeElement : null;
}

function describeElement(element: Element | null): string {
  if (!element) return "null";
  const doc = element.ownerDocument;
  if (element === doc.body) return "body";
  if (element === doc.documentElement) return "documentElement";
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const cls = element.classList.length > 0 ? `.${Array.from(element.classList).join(".")}` : "";
  return `${tag}${id}${cls}`;
}

function defaultScheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

export function createTerminalFocusOwnership(
  options: TerminalFocusOwnershipOptions,
): TerminalFocusOwnership {
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
  const trace: FocusOwnershipTrace = (event, payload) => options.onTrace?.(event, payload);

  let ownedHelper: HTMLTextAreaElement | null = null;
  /** Bumped by every ownership change so deferred restores can self-cancel. */
  let generation = 0;
  let disposed = false;

  const clear = (reason: string) => {
    generation += 1;
    if (!ownedHelper) return;
    ownedHelper = null;
    trace("focus-ownership-cleared", { reason });
  };

  return {
    captureOnAppBlur() {
      if (disposed) return false;
      const container = options.getContainer();
      const doc = container?.ownerDocument ?? null;
      const helper = findActiveHelperTextarea(container, doc?.activeElement ?? null);
      if (!helper) {
        // Focus was elsewhere (another pane, composer, sidebar) — this pane
        // owns nothing and must not restore anything on return.
        clear("blur-without-helper-focus");
        return false;
      }
      generation += 1;
      ownedHelper = helper;
      trace("focus-ownership-captured", {
        helper: describeElement(helper),
        activeElement: describeElement(doc?.activeElement ?? null),
      });
      return true;
    },

    reclaimOnAppFocus() {
      if (disposed) return false;
      const helper = ownedHelper;
      if (!helper) return false;
      const container = options.getContainer();
      if (!container || !helper.isConnected || !container.contains(helper)) {
        clear("reclaim-stale-helper");
        return false;
      }
      const doc = helper.ownerDocument;
      const activeElement = doc.activeElement;
      if (activeElement === helper) {
        // The webview kept DOM focus across deactivation — nothing to do.
        clear("reclaim-already-focused");
        return false;
      }
      if (!isUnownedActiveElement(activeElement, doc)) {
        // Something else (modal, search, another pane) owns focus now.
        clear("reclaim-focus-elsewhere");
        trace("focus-ownership-reclaim-declined", {
          reason: "focus-elsewhere",
          activeElement: describeElement(activeElement),
        });
        return false;
      }

      const scheduledGeneration = generation;
      trace("focus-ownership-reclaim-scheduled", {
        helper: describeElement(helper),
        activeElement: describeElement(activeElement),
      });
      scheduleFrame(() => {
        if (disposed || generation !== scheduledGeneration || ownedHelper !== helper) {
          trace("focus-ownership-reclaim-declined", { reason: "ownership-changed" });
          return;
        }
        const currentContainer = options.getContainer();
        if (!currentContainer || !helper.isConnected || !currentContainer.contains(helper)) {
          clear("reclaim-frame-stale-helper");
          return;
        }
        const active = helper.ownerDocument.activeElement;
        if (active !== helper && !isUnownedActiveElement(active, helper.ownerDocument)) {
          clear("reclaim-frame-focus-elsewhere");
          trace("focus-ownership-reclaim-declined", {
            reason: "frame-focus-elsewhere",
            activeElement: describeElement(active),
          });
          return;
        }
        clear("reclaim-attempted");
        helper.focus();
        trace("focus-ownership-reclaimed", {
          helper: describeElement(helper),
          activeElement: describeElement(helper.ownerDocument.activeElement),
        });
      });
      return true;
    },

    releaseForPointerTarget(target) {
      if (disposed || !ownedHelper) return;
      const container = options.getContainer();
      const node = typeof Node !== "undefined" && target instanceof Node ? target : null;
      if (container && node && container.contains(node)) return;
      clear("pointer-handoff");
    },

    notifyHelperBound(helper) {
      if (disposed || !ownedHelper) return;
      if (ownedHelper === helper) return;
      clear("helper-replaced");
    },

    clear,

    getOwnedHelper() {
      return ownedHelper;
    },

    dispose() {
      clear("disposed");
      disposed = true;
    },
  };
}
