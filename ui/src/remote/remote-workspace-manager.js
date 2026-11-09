import { setRemoteAttribute, setRemoteHtml, t, setRemoteText } from "./remote-i18n.js";
import { setRemoteIcon } from "./remote-icons.js";

// Workspace operations stay local to the Remote surface; the host owns names.
export function createWorkspaceManager({ getLease, rename, hide, saveTemplate, remove }) {
  const { document, window } = globalThis;
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-manager";
  dialog.id = "workspaceManager";
  dialog.setAttribute("aria-labelledby", "workspaceManagerTitle");
  setRemoteHtml(
    dialog,
    '\n    <div class="workspace-manager-heading">\n      <h2 id="workspaceManagerTitle"></h2>\n      <button type="button" class="item-manager-dismiss" data-workspace-action="close" aria-label="Close workspace management" title="Close menu" data-remote-i18n-title="Close menu" data-remote-i18n-aria-label="Close workspace management"></button>\n    </div>\n    <div id="workspaceManagerActions">\n      <button type="button" data-workspace-action="rename" data-remote-i18n="Rename workspace">Rename workspace</button>\n      <button type="button" data-workspace-action="template" data-remote-i18n="Save as template">Save as template</button>\n      <button type="button" data-workspace-action="hide" data-remote-i18n="Hide workspace">Hide workspace</button>\n      <button type="button" data-workspace-action="remove" class="pane-close-button" hidden data-remote-i18n="Close workspace">Close workspace</button>\n    </div>\n    <form id="workspaceRenameForm" hidden>\n      <label for="workspaceNameInput" data-remote-i18n="Workspace name">Workspace name</label>\n      <input id="workspaceNameInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required />\n      <div class="workspace-manager-footer">\n        <button type="button" data-workspace-action="cancel" data-remote-i18n="Cancel">Cancel</button>\n        <button type="submit" class="primary" data-remote-i18n="Save">Save</button>\n      </div>\n    </form>\n    <p role="alert" hidden></p>',
  );
  document.body.append(dialog);
  setRemoteIcon(dialog.querySelector('[data-workspace-action="close"]'), "X");
  const title = dialog.querySelector("h2");
  const actions = dialog.querySelector("#workspaceManagerActions");
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const error = dialog.querySelector("[role=alert]");
  const hideButton = dialog.querySelector('[data-workspace-action="hide"]');
  const removeButton = dialog.querySelector('[data-workspace-action="remove"]');
  let canRemove = false;
  let target = null;
  let trigger = null;
  let openingLease = null;
  let revision = 0;
  let busy = false;
  let canHide = false;
  let formMode = "rename";

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
    removeButton.disabled = value || !canRemove;
    setRemoteAttribute(
      removeButton,
      "title",
      canRemove ? t("Close workspace") : t("The last visible workspace cannot be closed"),
    );
    setRemoteAttribute(
      hideButton,
      "title",
      canHide ? t("Hide workspace") : t("The last visible workspace cannot be hidden"),
    );
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
      setRemoteText(error, err.message || String(err));
      error.hidden = false;
    } finally {
      if (revision === selectedRevision) setBusy(false);
    }
  }

  dialog.querySelector('[data-workspace-action="rename"]').addEventListener("click", () => {
    if (!authorized()) return;
    actions.hidden = true;
    form.hidden = false;
    formMode = "rename";
    setRemoteText(form.querySelector("label"), t("Workspace name"));
    input.value = target.name;
    input.focus();
    input.select();
  });
  dialog.querySelector('[data-workspace-action="template"]').addEventListener("click", () => {
    if (!authorized()) return;
    formMode = "template";
    actions.hidden = true;
    form.hidden = false;
    setRemoteText(form.querySelector("label"), t("Template name"));
    input.value = target.name;
    input.focus();
    input.select();
  });
  hideButton.addEventListener("click", () => {
    if (canHide) void perform((id, lease) => hide(id, lease));
  });
  removeButton.addEventListener("click", () => {
    if (busy || !canRemove || !authorized()) return;
    void perform((id, lease) => remove(id, lease));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!authorized()) return;
    const name = input.value.trim();
    if (!name) {
      setRemoteText(
        error,
        formMode === "template" ? t("Enter a template name.") : t("Enter a workspace name."),
      );
      error.hidden = false;
      input.focus();
      return;
    }
    const action = formMode === "template" ? saveTemplate : rename;
    void perform((id, lease) => action(id, name, lease));
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
    open(workspace, canHideWorkspace, button, options = {}) {
      if (!getLease()) return;
      revision += 1;
      target = { id: workspace.id, name: workspace.name || workspace.id };
      openingLease = getLease();
      trigger = button;
      canHide = canHideWorkspace;
      canRemove = Boolean(remove && options.canClose);
      removeButton.hidden = !remove;
      setRemoteText(title, target.name);
      actions.hidden = false;
      form.hidden = true;
      error.hidden = true;
      setBusy(false);
      trigger.setAttribute("aria-expanded", "true");
      if (!dialog.open) dialog.showModal();
      if (options.rename) dialog.querySelector('[data-workspace-action="rename"]').click();
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
      canRemove = Boolean(remove && workspaces.filter((item) => !item.hidden).length > 1);
      removeButton.disabled = busy || !canRemove;
      hideButton.disabled = busy || !canHide;
      setRemoteAttribute(
        hideButton,
        "title",
        canHide ? t("Hide workspace") : t("The last visible workspace cannot be hidden"),
      );
    },
    isOpen: () => dialog.open,
    isOpenFor: (id) => dialog.open && target?.id === id,
    close,
  };
}
