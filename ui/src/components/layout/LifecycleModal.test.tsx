import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@/lib/tauri-api";
import { useLifecycleStore } from "@/stores/lifecycle-store";

const api = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), get: vi.fn(), listen: vi.fn() }));
vi.mock("@/lib/tauri-api", () => ({
  checkAppUpdate: api.check,
  installAppUpdate: api.install,
  getAppUpdateStatus: api.get,
  onAppUpdateStatusChanged: api.listen,
}));
import { LifecycleModal } from "./LifecycleModal";
const status: AppUpdateStatus = {
  enabled: true,
  channel: "beta",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0-beta.1",
  notes: "Release notes",
  publishedAt: null,
  operation: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  checkedAtMs: null,
  lastError: null,
  exitSettings: { interruptTerminals: true, interruptRounds: 3, settleMs: 700 },
};
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  api.listen.mockResolvedValue(() => {});
  api.get.mockResolvedValue(status);
  api.install.mockResolvedValue({ ...status, operation: "downloading" });
  api.check.mockResolvedValue(status);
  useLifecycleStore.setState({
    open: true,
    kind: "update",
    status,
    progress: null,
    preview: false,
    error: null,
    forceClose: null,
  });
});
describe("LifecycleModal", () => {
  it("restores the real host status after dismissing a shutdown preview", async () => {
    useLifecycleStore.setState({
      kind: "close",
      preview: true,
      cleanup: true,
      progress: { stage: "settling", completed: 200, total: 700 },
      status: { ...status, operation: "preparing" },
    });
    render(<LifecycleModal />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    await waitFor(() => expect(useLifecycleStore.getState().status?.operation).toBe("idle"));
    expect(useLifecycleStore.getState().kind).toBe("update");
    expect(useLifecycleStore.getState().preview).toBe(false);
    expect(useLifecycleStore.getState().open).toBe(false);
    expect(api.install).not.toHaveBeenCalled();
  });
  it("shows channel and interruption impact before one explicit install action", async () => {
    render(<LifecycleModal />);
    expect(screen.getByText("Beta channel")).toBeInTheDocument();
    expect(screen.getByText(/Running tasks will be interrupted/)).toBeInTheDocument();
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    await waitFor(() => expect(screen.getByText("Updating Laymux")).toBeInTheDocument());
    expect(api.install).toHaveBeenCalledOnce();
  });
  it("keeps a minimized download running and reopens for preparation", async () => {
    api.get.mockResolvedValue({ ...status, operation: "downloading" });
    useLifecycleStore.setState({ status: { ...status, operation: "downloading" } });
    render(<LifecycleModal />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(useLifecycleStore.getState().open).toBe(false);
    act(() =>
      useLifecycleStore.getState().receiveStatus({
        ...status,
        operation: "preparing",
        preparation: { stage: "settling", completed: 350, total: 700 },
      }),
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    fireEvent(screen.getByTestId("lifecycle-modal"), new Event("cancel", { cancelable: true }));
    expect(useLifecycleStore.getState().open).toBe(true);
    expect(api.install).not.toHaveBeenCalled();
  });
  it("does not show invented percentages for installer work", () => {
    useLifecycleStore.setState({ status: { ...status, operation: "installing" } });
    render(<LifecycleModal />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
  it("does not surface a background check error as an explicit action failure", async () => {
    api.get.mockResolvedValue({ ...status, lastError: "background network error" });
    render(<LifecycleModal />);
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    api.check.mockResolvedValue({ ...status, lastError: "explicit check failed" });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("explicit check failed");
  });
});
