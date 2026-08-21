import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateStatus } from "@/lib/tauri-api";

const getAppUpdateStatus = vi.fn<() => Promise<AppUpdateStatus>>();
const installAppUpdate = vi.fn<() => Promise<AppUpdateStatus>>();
let statusListener: ((status: AppUpdateStatus) => void) | null = null;

vi.mock("@/lib/tauri-api", () => ({
  getAppUpdateStatus: () => getAppUpdateStatus(),
  installAppUpdate: () => installAppUpdate(),
  onAppUpdateStatusChanged: (listener: (status: AppUpdateStatus) => void) => {
    statusListener = listener;
    return Promise.resolve(() => {});
  },
}));

import { UpdateButton } from "./UpdateButton";

const status = (overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  enabled: true,
  channel: "stable",
  currentVersion: "0.10.13",
  availableVersion: null,
  notes: null,
  publishedAt: null,
  operation: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  checkedAtMs: Date.now(),
  lastError: null,
  ...overrides,
});

describe("UpdateButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusListener = null;
    getAppUpdateStatus.mockResolvedValue(status());
    installAppUpdate.mockResolvedValue(
      status({ availableVersion: "0.11.0", operation: "downloading" }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("stays absent when this build has no available update", async () => {
    render(<UpdateButton />);
    await act(async () => {});
    expect(screen.queryByTestId("app-update-btn")).not.toBeInTheDocument();
  });

  it("appears from a backend event and schedules an accepted install", async () => {
    const user = userEvent.setup();
    render(<UpdateButton />);
    await act(async () => {});

    act(() => statusListener?.(status({ availableVersion: "0.11.0" })));
    const button = screen.getByTestId("app-update-btn");
    expect(button).toHaveStyle({ color: "var(--yellow)" });
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("0.11.0"));

    await user.click(button);
    expect(window.confirm).toHaveBeenCalled();
    expect(installAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("names the beta channel so a test build is not mistaken for a stable one", async () => {
    render(<UpdateButton />);
    await act(async () => {});

    act(() => statusListener?.(status({ availableVersion: "0.11.0-beta.1", channel: "beta" })));
    expect(screen.getByTestId("app-update-btn")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("beta channel"),
    );
  });

  it("shows download progress and prevents a duplicate install", async () => {
    const user = userEvent.setup();
    getAppUpdateStatus.mockResolvedValue(
      status({
        availableVersion: "0.11.0",
        operation: "downloading",
        downloadedBytes: 40,
        totalBytes: 100,
      }),
    );
    render(<UpdateButton />);
    await act(async () => {});

    const button = screen.getByTestId("app-update-btn");
    expect(button).toHaveTextContent("40");
    expect(button).toBeDisabled();
    await user.click(button);
    expect(installAppUpdate).not.toHaveBeenCalled();
  });
});
