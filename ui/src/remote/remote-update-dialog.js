import { lifecycleCopy, lifecycleSteps, progressPercent } from "../lib/lifecycle-progress.ts";
import "../components/ui/lifecycle.css";
const { document, location, setTimeout, clearTimeout } = globalThis;

/** Same stages/copy as desktop, backed only by the host update snapshot. */
export function createRemoteUpdateDialog({ check, install, getCanInstall, host = location.host }) {
  const copy = lifecycleCopy.en;
  const dialog = document.createElement("dialog");
  const backdrop = document.createElement("div");
  backdrop.className = "lifecycle-backdrop";
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  document.body.append(backdrop);
  dialog.className = "lifecycle-dialog remote-update-dialog";
  dialog.setAttribute("aria-label", "Connected PC update");
  dialog.dataset.testid = "remote-update-dialog";
  document.body.append(dialog);
  let status = null;
  let error = null;
  let busyRequest = false;
  let expectedVersion = null;
  let installingObserved = false;
  let reconnectSince = null;
  let reconnectTimer = null;
  let complete = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function button(text, action, disabled = false, primary = false) {
    const node = element("button", primary ? "primary" : "", text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function isBusy() {
    return ["downloading", "preparing", "installing"].includes(status?.operation);
  }
  function locked() {
    return status?.operation === "preparing" || status?.operation === "installing";
  }
  function open() {
    backdrop.hidden = false;
    render();
    if (!dialog.open) dialog.showModal();
  }
  async function run(action) {
    if (busyRequest) return;
    busyRequest = true;
    error = null;
    render();
    try {
      await action();
    } catch (cause) {
      error = String(cause);
    } finally {
      busyRequest = false;
      render();
    }
  }
  function render() {
    const focused = dialog.contains(document.activeElement)
      ? document.activeElement?.textContent
      : null;
    const content = element("div", "lifecycle-content");
    content.append(
      element(
        "h2",
        "lifecycle-title",
        complete
          ? "Update complete"
          : reconnectSince && installingObserved
            ? "Waiting for Laymux to restart"
            : `PC update ? ${host}`,
      ),
    );
    const version = element("div", "lifecycle-version");
    version.append(
      element("span", "", status?.currentVersion ?? "—"),
      element("span", "", "→"),
      element(
        "strong",
        "",
        expectedVersion ?? status?.availableVersion ?? status?.currentVersion ?? "—",
      ),
      element("span", "lifecycle-channel", status?.channel === "beta" ? copy.beta : copy.stable),
    );
    content.append(version);
    if (complete)
      content.append(
        element("p", "lifecycle-subtitle", "Reconnected and verified the new version."),
      );
    else if (reconnectSince) {
      content.append(
        element(
          "p",
          "lifecycle-subtitle",
          installingObserved
            ? "The app on your PC is restarting. Reconnecting automatically…"
            : "Connection interrupted. Checking the PC's update status…",
        ),
      );
      if (Date.now() - reconnectSince > 60000)
        content.append(
          element(
            "div",
            "lifecycle-error",
            "The PC has not reconnected yet. Check that Laymux is running.",
          ),
        );
    } else if (isBusy()) {
      const progress =
        status.operation === "downloading"
          ? { stage: "downloading", completed: status.downloadedBytes, total: status.totalBytes }
          : status.operation === "installing"
            ? { stage: "installing", completed: 0, total: null }
            : (status.preparation ?? { stage: "checkpoint", completed: 0, total: null });
      const steps = lifecycleSteps("update", status.exitSettings?.interruptTerminals === true);
      const active = steps.indexOf(progress.stage === "settling" ? "interrupting" : progress.stage);
      const list = element("ol", "lifecycle-steps");
      list.setAttribute("aria-live", "polite");
      steps.forEach((stage, index) => {
        const row = element(
          "li",
          `lifecycle-step ${index === active ? "is-active" : index < active ? "is-done" : ""}`,
        );
        row.append(
          element("span", "lifecycle-step-icon", index < active ? "✓" : String(index + 1)),
        );
        const body = element("div", "lifecycle-step-body", copy[stage]);
        if (index === active) {
          const percent = progress.stage === "interrupting" ? null : progressPercent(progress);
          const detail = element(
            "div",
            "lifecycle-step-detail",
            progress.stage === "settling"
              ? copy.settling
              : progress.stage === "interrupting"
                ? copy.interrupted
                : "",
          );
          detail.append(element("span", "", percent === null ? "" : `${percent}%`));
          body.append(detail);
          const track = element("div", "lifecycle-track");
          track.setAttribute("role", "progressbar");
          track.setAttribute("aria-label", copy[stage]);
          if (percent !== null) track.setAttribute("aria-valuenow", String(percent));
          const bar = element("div", `lifecycle-bar ${percent === null ? "is-indeterminate" : ""}`);
          bar.style.width = percent === null ? "35%" : `${percent}%`;
          track.append(bar);
          body.append(track);
        }
        row.append(body);
        list.append(row);
      });
      content.append(list);
      if (progress.warning) content.append(element("div", "lifecycle-error", progress.warning));
    } else {
      if (status?.notes) {
        const notes = element("details", "lifecycle-notes");
        notes.open = true;
        notes.append(element("summary", "", copy.details), element("pre", "", status.notes));
        content.append(notes);
      }
      content.append(
        element(
          "p",
          "lifecycle-subtitle",
          status?.enabled === false
            ? copy.dev
            : status?.availableVersion
              ? copy.ready
              : copy.latest,
        ),
      );
      content.append(
        element(
          "div",
          "lifecycle-info",
          status?.exitSettings?.interruptTerminals ? copy.cleanupOn : copy.cleanupOff,
        ),
      );
    }
    if (error) {
      const alert = element("div", "lifecycle-error", error);
      alert.setAttribute("role", "alert");
      content.append(alert);
    }
    const actions = element("div", "lifecycle-actions");
    if (!locked() || reconnectSince || complete)
      actions.append(button(isBusy() && !complete ? copy.hide : "Close", () => dialog.close()));
    if (reconnectSince) actions.append(button("Retry connection", () => void run(check)));
    else if (!isBusy() && !complete) {
      actions.append(
        button(
          copy.check,
          () => void run(check),
          busyRequest || !status?.enabled || status?.operation === "checking",
        ),
      );
      if (status?.availableVersion)
        actions.append(
          button(
            copy.install,
            () => void run(install),
            busyRequest || !status.enabled || status.operation !== "idle" || !getCanInstall(),
            true,
          ),
        );
      if (!getCanInstall())
        content.append(
          element("p", "lifecycle-subtitle", "Take control of the PC to install an update."),
        );
    }
    dialog.replaceChildren(content, ...(actions.childElementCount ? [actions] : []));
    if (focused)
      [...dialog.querySelectorAll("button")].find((node) => node.textContent === focused)?.focus();
  }
  dialog.addEventListener("cancel", (event) => {
    if (locked() && !reconnectSince) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    backdrop.hidden = true;
  });
  return {
    open,
    update(next) {
      const previous = status?.operation;
      status = next;
      error = next.lastError ?? null;
      if (isBusy()) expectedVersion = next.availableVersion;
      if (next.operation === "installing") installingObserved = true;
      if (expectedVersion && next.currentVersion === expectedVersion && next.operation === "idle")
        complete = true;
      if (next.operation === "idle" && next.lastError) {
        expectedVersion = null;
        installingObserved = false;
      }
      reconnectSince = null;
      clearTimeout(reconnectTimer);
      if (isBusy() && previous !== next.operation) open();
      else render();
    },
    disconnected(message) {
      error = installingObserved ? null : message;
      if (expectedVersion) {
        reconnectSince ??= Date.now();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(render, Math.max(0, 60001 - (Date.now() - reconnectSince)));
      }
      render();
    },
    destroy() {
      clearTimeout(reconnectTimer);
      dialog.remove();
      backdrop.remove();
    },
  };
}
