import { setRemoteIcon } from "./remote-icons.js";

// The selected content id and lease own the transient two-click state.
export function createPaneControls({
  hideButton,
  closeButton,
  hide,
  close,
  onError,
  iconOnly = true,
}) {
  let target = null;
  let lease = null;
  let armed = false;
  let busy = false;
  let closedId = null;

  function render() {
    hideButton.hidden = !target?.canHide;
    closeButton.hidden = !target?.canClose;
    hideButton.disabled = !lease || busy || !target?.canHide;
    closeButton.disabled = !lease || busy || !target?.canClose || closedId === target.id;
    hideButton.setAttribute("aria-pressed", String(Boolean(target?.hidden)));
    const label = target?.hidden ? "Show pane in workspace list" : "Hide pane from workspace list";
    hideButton.setAttribute("aria-label", label);
    hideButton.title = label;
    if (iconOnly) setRemoteIcon(hideButton, target?.hidden ? "EyeOff" : "Eye");
    else hideButton.textContent = target?.hidden ? "Show pane" : "Hide pane";
    if (armed) closeButton.dataset.confirming = "true";
    else delete closeButton.dataset.confirming;
  }

  function disarm() {
    armed = false;
    render();
  }

  async function perform(operation, closing) {
    const selected = target;
    const selectedLease = lease;
    if (!selected || !selectedLease || busy) return;
    armed = false;
    busy = true;
    render();
    try {
      await operation(selected, selectedLease);
      if (closing && target?.id === selected.id && lease === selectedLease) closedId = selected.id;
    } catch (error) {
      if (target?.id === selected.id && lease === selectedLease) onError(error);
    } finally {
      busy = false;
      render();
    }
  }

  hideButton.addEventListener("click", () => {
    if (!hideButton.disabled) {
      void perform((pane, selectedLease) => hide(pane.id, !pane.hidden, selectedLease), false);
    }
  });
  closeButton.addEventListener("click", () => {
    if (closeButton.disabled) return;
    if (!armed) {
      armed = true;
      render();
      return;
    }
    void perform((pane, selectedLease) => close(pane.id, selectedLease), true);
  });
  closeButton.addEventListener("blur", disarm);
  closeButton.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") disarm();
  });
  closeButton.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && armed) {
      event.preventDefault();
      disarm();
    }
  });
  hideButton.ownerDocument.addEventListener("pointerdown", (event) => {
    if (armed && !closeButton.contains(event.target)) disarm();
  });

  return {
    update(nextTarget, nextLease) {
      if (target?.id !== nextTarget?.id || lease !== nextLease || !nextTarget?.canClose) {
        armed = false;
        closedId = null;
      }
      target = nextTarget;
      lease = nextLease;
      render();
    },
  };
}

export function createPaneManager({ getLease, hide, close }) {
  const { document, window } = globalThis;
  const dialog = document.createElement("dialog");
  dialog.id = "paneManager";
  dialog.className = "workspace-manager";
  dialog.setAttribute("aria-labelledby", "paneManagerTitle");
  dialog.innerHTML = `<div class="workspace-manager-heading"><h2 id="paneManagerTitle"></h2>
    <button type="button" class="item-manager-dismiss" data-pane-action="dismiss" aria-label="Close pane management" title="Close menu"></button></div>
    <div class="item-manager-actions"><button type="button" data-pane-action="hide">Hide pane</button>
    <button type="button" data-pane-action="close-pane" class="pane-close-button">Close pane</button></div>
    <p role="alert" hidden></p>`;
  document.body.append(dialog);
  setRemoteIcon(dialog.querySelector('[data-pane-action="dismiss"]'), "X");
  const title = dialog.querySelector("h2");
  const error = dialog.querySelector("[role=alert]");
  let target = null;
  let openingLease = null;
  let trigger = null;
  let revision = 0;
  function dismiss() {
    revision += 1;
    controls.update(null, null);
    if (dialog.open) dialog.close();
  }
  async function perform(action, ...args) {
    if (!target || getLease() !== openingLease) {
      dismiss();
      return;
    }
    error.hidden = true;
    const selectedRevision = revision;
    await action(...args);
    if (selectedRevision === revision) dismiss();
  }
  const controls = createPaneControls({
    hideButton: dialog.querySelector('[data-pane-action="hide"]'),
    closeButton: dialog.querySelector('[data-pane-action="close-pane"]'),
    iconOnly: false,
    hide: (...args) => perform(hide, ...args),
    close: (...args) => perform(close, ...args),
    onError: (err) => {
      error.textContent = err.message || String(err);
      error.hidden = false;
    },
  });
  dialog.querySelector('[data-pane-action="dismiss"]').addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (!dialog.open) return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    },
    true,
  );
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      dismiss();
  });
  dialog.addEventListener("close", () => {
    controls.update(null, null);
    trigger?.setAttribute("aria-expanded", "false");
    const replacement = [...document.querySelectorAll("[data-pane-manage]")].find(
      (button) => button.dataset.paneManage === target?.id,
    );
    (replacement || (trigger?.isConnected ? trigger : null))?.focus({ preventScroll: true });
  });
  return {
    open(pane, button) {
      if (!getLease()) return;
      revision += 1;
      target = pane;
      openingLease = getLease();
      trigger = button;
      title.textContent = pane.label;
      error.hidden = true;
      controls.update(pane, openingLease);
      trigger.setAttribute("aria-expanded", "true");
      if (!dialog.open) dialog.showModal();
    },
    sync(panes) {
      if (!dialog.open) return;
      const pane = panes.find((item) => item.id === target?.id);
      if (!pane || openingLease !== getLease()) {
        dismiss();
        return;
      }
      target = pane;
      title.textContent = pane.label;
      controls.update(pane, openingLease);
    },
    isOpenFor: (id) => dialog.open && target?.id === id,
    isOpen: () => dialog.open,
    close: dismiss,
  };
}

export function installWorkspaceRenameGesture(element, rename) {
  let timer = null;
  let origin = null;
  let fired = false;
  const cancel = () => {
    globalThis.clearTimeout(timer);
    timer = null;
  };
  element.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      event.target.closest("button, input, textarea, a, .workspace-pane-list")
    )
      return;
    origin = { x: event.clientX, y: event.clientY };
    fired = false;
    timer = globalThis.setTimeout(() => {
      timer = null;
      if (!element.isConnected) return;
      fired = true;
      rename();
    }, 450);
  });
  element.addEventListener("pointermove", (event) => {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel();
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave"])
    element.addEventListener(name, cancel);
  element.addEventListener("contextmenu", (event) => {
    if (fired || timer) event.preventDefault();
  });
  element.addEventListener(
    "click",
    (event) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}
