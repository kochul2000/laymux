import { setRemoteIcon } from "./remote-icons.js";

// Workspace operations stay local to the Remote surface; the host owns names.
export function createWorkspaceManager({ getLease, rename, hide }) {
  const { document, window } = globalThis;
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-manager";
  dialog.id = "workspaceManager";
  dialog.setAttribute("aria-labelledby", "workspaceManagerTitle");
  dialog.innerHTML = `
    <div class="workspace-manager-heading">
      <h2 id="workspaceManagerTitle"></h2>
      <button type="button" data-workspace-action="close" aria-label="Close workspace management"></button>
    </div>
    <div id="workspaceManagerActions">
      <button type="button" data-workspace-action="rename">Rename workspace</button>
      <button type="button" data-workspace-action="hide">Hide workspace</button>
    </div>
    <form id="workspaceRenameForm" hidden>
      <label for="workspaceNameInput">Workspace name</label>
      <input id="workspaceNameInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required />
      <div class="workspace-manager-footer">
        <button type="button" data-workspace-action="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
    <p role="alert" hidden></p>`;
  document.body.append(dialog);
  setRemoteIcon(dialog.querySelector('[data-workspace-action="close"]'), "X");
  const title = dialog.querySelector("h2");
  const actions = dialog.querySelector("#workspaceManagerActions");
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const error = dialog.querySelector("[role=alert]");
  const hideButton = dialog.querySelector('[data-workspace-action="hide"]');
  let target = null;
  let trigger = null;
  let openingLease = null;
  let revision = 0;
  let busy = false;
  let canHide = false;

  function close() {
    revision += 1;
    if (dialog.open) dialog.close();
  }

  function authorized() {
    if (target && openingLease && openingLease === getLease()) return true;
    close();
    return false;
  }

  function setBusy(value) {
    busy = value;
    dialog.setAttribute("aria-busy", String(value));
    dialog.querySelectorAll("button, input").forEach((element) => {
      element.disabled = value;
    });
    hideButton.disabled = value || !canHide;
  }

  async function perform(operation) {
    if (busy || !authorized()) return;
    const selectedRevision = revision;
    error.hidden = true;
    setBusy(true);
    try {
      await operation(target.id, openingLease);
      if (revision === selectedRevision) close();
    } catch (err) {
      if (revision !== selectedRevision || !authorized()) return;
      error.textContent = err.message || String(err);
      error.hidden = false;
    } finally {
      if (revision === selectedRevision) setBusy(false);
    }
  }

  dialog.querySelector('[data-workspace-action="rename"]').addEventListener("click", () => {
    if (!authorized()) return;
    actions.hidden = true;
    form.hidden = false;
    input.value = target.name;
    input.focus();
    input.select();
  });
  hideButton.addEventListener("click", () => {
    if (canHide) void perform((id, lease) => hide(id, lease));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!authorized()) return;
    const name = input.value.trim();
    if (!name) {
      error.textContent = "Enter a workspace name.";
      error.hidden = false;
      input.focus();
      return;
    }
    void perform((id, lease) => rename(id, name, lease));
  });
  for (const action of ["close", "cancel"]) {
    dialog.querySelector(`[data-workspace-action="${action}"]`).addEventListener("click", close);
  }
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !busy) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        close();
    }
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (!dialog.open) return;
      // A modal keystroke must never reach the terminal's global input handler.
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    },
    true,
  );
  dialog.addEventListener("close", () => {
    revision += 1;
    trigger?.setAttribute("aria-expanded", "false");
    const replacement =
      target &&
      Array.from(document.querySelectorAll("[data-workspace-manage]")).find(
        (button) => button.dataset.workspaceManage === target.id,
      );
    (replacement || (trigger?.isConnected ? trigger : null))?.focus({ preventScroll: true });
  });

  return {
    open(workspace, canHideWorkspace, button) {
      if (!getLease()) return;
      revision += 1;
      target = { id: workspace.id, name: workspace.name || workspace.id };
      openingLease = getLease();
      trigger = button;
      canHide = canHideWorkspace;
      title.textContent = target.name;
      actions.hidden = false;
      form.hidden = true;
      error.hidden = true;
      setBusy(false);
      trigger.setAttribute("aria-expanded", "true");
      if (!dialog.open) dialog.showModal();
    },
    sync(workspaces) {
      if (!dialog.open) return;
      if (!authorized()) return;
      const workspace = workspaces.find((item) => item.id === target.id);
      if (!workspace || workspace.hidden) {
        close();
        return;
      }
      canHide = !workspace.isActive || workspaces.filter((item) => !item.hidden).length > 1;
      hideButton.disabled = busy || !canHide;
    },
    isOpen: () => dialog.open,
    isOpenFor: (id) => dialog.open && target?.id === id,
    close,
  };
}
