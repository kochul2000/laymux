// The host owns actual close deadlines; this surface only renders undo affordances.
export function createWorkspaceCloseToasts({ getLease, restore, onError }) {
  const { document, setTimeout, clearTimeout } = globalThis;
  const container = document.createElement("div");
  container.className = "workspace-close-toasts";
  document.body.append(container);
  const entries = new Map();
  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.element.remove();
    entries.delete(id);
  }
  return {
    sync(pending = [], serverTime) {
      const lease = getLease();
      const localNow = Date.now();
      const hostNow = Number.isFinite(serverTime) ? serverTime : localNow;
      const current = new Map(pending.map((item) => [item.id, item]));
      for (const [id, entry] of entries) {
        if (current.get(id)?.expiresAt !== entry.expiresAt || entry.lease !== lease) remove(id);
      }
      if (!lease) return;
      for (const item of pending) {
        const remainingMs = item.expiresAt - hostNow;
        if (entries.has(item.id) || remainingMs <= 0) continue;
        const element = document.createElement("div");
        element.className = "workspace-close-toast";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        const message = document.createElement("span");
        message.textContent = `Closing ${item.name}…`;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Restore";
        button.dataset.workspaceRestore = item.id;
        const entry = {
          element,
          lease,
          expiresAt: item.expiresAt,
          localDeadline: localNow + remainingMs,
          timer: setTimeout(() => remove(item.id), remainingMs),
        };
        button.addEventListener("click", async () => {
          if (button.disabled || getLease() !== lease || entry.localDeadline <= Date.now()) return;
          button.disabled = true;
          try {
            await restore(item.id, lease);
            if (entries.get(item.id) === entry) remove(item.id);
          } catch (error) {
            if (getLease() !== lease || entries.get(item.id) !== entry) return;
            button.disabled = false;
            onError(error);
          }
        });
        element.append(message, button);
        container.append(element);
        entries.set(item.id, entry);
      }
    },
  };
}
