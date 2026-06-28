import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRemoteControlStatus: vi.fn(),
  onRemoteControlChanged: vi.fn(),
  reclaimRemoteControl: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  getRemoteControlStatus: api.getRemoteControlStatus,
  onRemoteControlChanged: api.onRemoteControlChanged,
  reclaimRemoteControl: api.reclaimRemoteControl,
}));

import { useSettingsStore } from "@/stores/settings-store";
import { RemoteControlOverlay } from "./RemoteControlOverlay";

describe("RemoteControlOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.getState().setRemote({ enabled: true });
    api.onRemoteControlChanged.mockResolvedValue(() => {});
  });

  it("does not poll while direct remote mode is disabled", async () => {
    useSettingsStore.getState().setRemote({ enabled: false });

    render(<RemoteControlOverlay />);
    await Promise.resolve();

    expect(api.getRemoteControlStatus).not.toHaveBeenCalled();
    expect(api.onRemoteControlChanged).not.toHaveBeenCalled();
  });

  it("renders while a remote controller is active", async () => {
    api.getRemoteControlStatus.mockResolvedValue({
      active: true,
      leaseId: "lease-1",
      remoteAddr: "100.64.0.2:51234",
      clientName: "phone",
      heartbeatTimeoutSeconds: 15,
    });

    render(<RemoteControlOverlay />);

    expect(await screen.findByTestId("remote-control-overlay")).toBeInTheDocument();
    expect(screen.getByText(/phone is controlling this PC/i)).toBeInTheDocument();
  });

  it("reclaims control from the PC", async () => {
    api.getRemoteControlStatus.mockResolvedValue({
      active: true,
      leaseId: "lease-1",
      remoteAddr: "100.64.0.2:51234",
      clientName: "phone",
      heartbeatTimeoutSeconds: 15,
    });
    api.reclaimRemoteControl.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });

    render(<RemoteControlOverlay />);

    await userEvent.click(await screen.findByRole("button", { name: /take back control/i }));

    expect(api.reclaimRemoteControl).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("remote-control-overlay")).not.toBeInTheDocument();
    });
  });
});
