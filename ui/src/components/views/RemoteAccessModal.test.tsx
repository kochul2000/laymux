import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });

  it("renders only the token URL and token fields", () => {
    setRemote({ enabled: true, authToken: "secret", allowedIps: ["100.64.0.0/10"] });

    render(<RemoteAccessModal />);

    expect(screen.getByText("URL + token")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(screen.getByText("http://<laymux-host>:19281/remote/#token=secret")).toBeInTheDocument();
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(screen.queryByText(/LX_AUTOMATION_/)).not.toBeInTheDocument();
    expect(screen.queryByText("Allowed IPs")).not.toBeInTheDocument();
    expect(screen.queryByText("Controller")).not.toBeInTheDocument();
    expect(screen.queryByText("Local URL")).not.toBeInTheDocument();
  });
});
