/* global document, window */
const TOOL_ORDER = ["issues", "pulls", "files", "memo"];

export function normalizeToolSwipeRightAction(value) {
  return value === "previous" ? "previous" : "close";
}

/** Visibility and capability are supplied by the same raw state as header rendering. */
export function nextRemoteTool(current, direction, available) {
  const start = TOOL_ORDER.indexOf(current);
  if (start < 0) return null;
  for (let offset = 1; offset < TOOL_ORDER.length; offset += 1) {
    const candidate =
      TOOL_ORDER[(start + direction * offset + TOOL_ORDER.length) % TOOL_ORDER.length];
    const group = candidate === "issues" || candidate === "pulls" ? "github" : candidate;
    if (available[group]) return candidate;
  }
  return null;
}

/** One pointer owner across all tool surfaces; never take over editor/file content. */
export function installRemoteToolSwipes({ getCurrent, enabled, resolveAction, perform }) {
  let gesture = null;
  let suppressClick = false;
  const selectionActive = () => Boolean(document.getSelection()?.toString());
  const valid = () => gesture && enabled() && getCurrent() === gesture.current;
  document.addEventListener(
    "pointerdown",
    (event) => {
      suppressClick = false;
      if (gesture || event.isPrimary === false) {
        gesture = null;
        return;
      }
      if (!enabled() || !["touch", "pen"].includes(event.pointerType)) return;
      const surface = event.target.closest?.("[data-remote-tool-swipe]");
      const current = getCurrent();
      const group = current === "issues" || current === "pulls" ? "github" : current;
      if (!surface || surface.dataset.remoteToolSwipe !== group || selectionActive()) return;
      if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        current,
        dragged: false,
      };
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (!valid() || selectionActive()) {
        gesture = null;
        return;
      }
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (gesture.dragged) {
        event.preventDefault();
        return;
      }
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        gesture = null;
        return;
      }
      if (Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        gesture.dragged = true;
        event.preventDefault();
      }
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const dragged = gesture.dragged;
      // Resolve again: live settings/capability changes must not resurrect hidden tools.
      const action =
        valid() &&
        !selectionActive() &&
        dragged &&
        Math.abs(dx) >= 56 &&
        Math.abs(dx) > Math.abs(dy) * 1.25
          ? resolveAction(dx < 0 ? 1 : -1)
          : null;
      gesture = null;
      if (dragged) {
        event.preventDefault();
        suppressClick = true;
      }
      if (action) perform(action);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  const cancel = () => {
    gesture = null;
  };
  document.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", cancel);
}
