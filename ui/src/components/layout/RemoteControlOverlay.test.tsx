import { act, render, screen, waitFor } from "@testing-library/react";
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

import { RemoteControlOverlay } from "./RemoteControlOverlay";

describe("RemoteControlOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.onRemoteControlChanged.mockResolvedValue(() => {});
  });

  it("subscribes to remote control changes", async () => {
    api.getRemoteControlStatus.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });

    render(<RemoteControlOverlay />);
    await Promise.resolve();

    expect(api.getRemoteControlStatus).toHaveBeenCalledTimes(1);
    expect(api.onRemoteControlChanged).toHaveBeenCalledTimes(1);
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

  it("drops a reclaim error when the remote controller changes", async () => {
    let eventHandler!: (status: {
      active: boolean;
      leaseId: string | null;
      remoteAddr: string | null;
      clientName: string | null;
      heartbeatTimeoutSeconds: number;
    }) => void;
    api.onRemoteControlChanged.mockImplementation(async (callback) => {
      eventHandler = callback;
      return () => {};
    });
    api.getRemoteControlStatus.mockResolvedValue({
      active: true,
      leaseId: "lease-1",
      remoteAddr: "100.64.0.2:51234",
      clientName: "phone",
      heartbeatTimeoutSeconds: 15,
    });
    api.reclaimRemoteControl.mockRejectedValue(new Error("reclaim failed"));

    render(<RemoteControlOverlay />);

    await userEvent.click(await screen.findByRole("button", { name: /take back control/i }));
    expect(await screen.findByText("reclaim failed")).toBeInTheDocument();

    act(() => {
      eventHandler({
        active: false,
        leaseId: null,
        remoteAddr: null,
        clientName: null,
        heartbeatTimeoutSeconds: 15,
      });
    });
    expect(screen.queryByTestId("remote-control-overlay")).not.toBeInTheDocument();

    act(() => {
      eventHandler({
        active: true,
        leaseId: "lease-2",
        remoteAddr: "100.64.0.3:51235",
        clientName: "tablet",
        heartbeatTimeoutSeconds: 15,
      });
    });
    expect(screen.getByText(/tablet is controlling this PC/i)).toBeInTheDocument();
    expect(screen.queryByText("reclaim failed")).not.toBeInTheDocument();
  });
});
