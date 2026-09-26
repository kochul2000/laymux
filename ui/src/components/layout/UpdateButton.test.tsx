import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { UpdateButton } from "./UpdateButton";
import { useLifecycleStore } from "@/stores/lifecycle-store";
import type { AppUpdateStatus } from "@/lib/tauri-api";
const status: AppUpdateStatus = {
  enabled: true,
  channel: "beta",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0-beta.1",
  notes: null,
  publishedAt: null,
  operation: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  checkedAtMs: null,
  lastError: null,
};
beforeEach(() =>
  useLifecycleStore.setState({ status, open: false, kind: "update", preview: false }),
);
describe("UpdateButton", () => {
  it("opens the shared dialog instead of installing directly", () => {
    render(<UpdateButton />);
    fireEvent.click(screen.getByTestId("app-update-btn"));
    expect(useLifecycleStore.getState().open).toBe(true);
    expect(useLifecycleStore.getState().status?.operation).toBe("idle");
  });
  it("remains usable to reopen minimized download progress", () => {
    useLifecycleStore.setState({ status: { ...status, operation: "downloading" } });
    render(<UpdateButton />);
    fireEvent.click(screen.getByTestId("app-update-btn"));
    expect(useLifecycleStore.getState().open).toBe(true);
  });
  it("is absent without an available update", () => {
    useLifecycleStore.setState({ status: { ...status, availableVersion: null } });
    render(<UpdateButton />);
    expect(screen.queryByTestId("app-update-btn")).not.toBeInTheDocument();
  });
});
