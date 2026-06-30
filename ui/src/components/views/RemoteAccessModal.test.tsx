import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRemoteControlStatus: vi.fn(),
  reclaimRemoteControl: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  getRemoteControlStatus: api.getRemoteControlStatus,
  reclaimRemoteControl: api.reclaimRemoteControl,
}));

import { useSettingsStore } from "@/stores/settings-store";
import { RemoteAccessModal } from "./RemoteAccessModal";

function setRemote(remote: Partial<ReturnType<typeof useSettingsStore.getState>["remote"]>) {
  useSettingsStore.getState().setRemote({
    enabled: false,
    bindAddress: "0.0.0.0",
    allowedOrigins: [],
    allowedIps: ["127.0.0.1/32", "::1/128"],
    authToken: "",
    heartbeatTimeoutSeconds: 15,
    ...remote,
  });
}

describe("RemoteAccessModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRemote({});
    api.getRemoteControlStatus.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });
  });

  it("renders remote-only status without automation variables", async () => {
    render(<RemoteAccessModal />);

    expect(await screen.findByText("Remote is off.")).toBeInTheDocument();
    expect(screen.getByText("http://<laymux-host>:19281/remote/")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:19281/remote/")).toBeInTheDocument();
    expect(screen.queryByText(/LX_AUTOMATION_/)).not.toBeInTheDocument();
  });

  it("shows ready state when remote is enabled with a token", async () => {
    setRemote({ enabled: true, authToken: "secret", allowedIps: ["100.64.0.0/10"] });

    render(<RemoteAccessModal />);

    expect(await screen.findByText("Remote is ready.")).toBeInTheDocument();
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(screen.getByText("http://<laymux-host>:19281/remote/#token=secret")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:19281/remote/#token=secret")).toBeInTheDocument();
    expect(screen.getByText("100.64.0.0/10")).toBeInTheDocument();
  });

  it("reclaims an active remote controller", async () => {
    setRemote({ enabled: true, authToken: "secret" });
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

    render(<RemoteAccessModal />);

    expect(await screen.findByText("phone is controlling this PC.")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("remote-access-reclaim"));

    expect(api.reclaimRemoteControl).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText("No active controller.")).toBeInTheDocument();
    });
  });
});
