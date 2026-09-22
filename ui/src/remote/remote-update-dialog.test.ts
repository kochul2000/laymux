import { beforeEach, describe, expect, it, vi } from "vitest";
// JS is bundled by the same Vite entry used for the real remote client.
// @ts-expect-error the remote client is intentionally JavaScript
import { createRemoteUpdateDialog } from "./remote-update-dialog.js";

beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
const status = {
  enabled: true,
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
  operation: "idle",
  exitSettings: { interruptTerminals: true },
};
describe("Remote update dialog", () => {
  it("shows the host and requires control before install", () => {
    const install = vi.fn();
    const modal = createRemoteUpdateDialog({
      check: vi.fn(),
      install,
      getCanInstall: () => false,
      host: "OFFICE-PC",
    });
    modal.update(status);
    modal.open();
    expect(document.body.textContent).toContain("OFFICE-PC");
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Update and restart",
    )!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(install).not.toHaveBeenCalled();
    modal.destroy();
  });
  it("only treats observed installation disconnect as a restart and verifies the target version", () => {
    const modal = createRemoteUpdateDialog({
      check: vi.fn(),
      install: vi.fn(),
      getCanInstall: () => true,
    });
    modal.update({ ...status, operation: "downloading" });
    modal.disconnected("offline");
    expect(document.body.textContent).toContain("Connection interrupted");
    expect(document.body.textContent).not.toContain("Update complete");
    modal.update({ ...status, operation: "installing" });
    modal.disconnected("offline");
    expect(document.body.textContent).toContain("Waiting for Laymux to restart");
    modal.update(status);
    expect(document.body.textContent).not.toContain("Update complete");
    modal.update({ ...status, currentVersion: "1.1.0", availableVersion: null });
    expect(document.body.textContent).toContain("Reconnected and verified the new version");
    modal.destroy();
  });
});
