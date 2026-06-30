import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
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
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockInvoke.mockResolvedValue({ port: 19281 });
    setRemote({});
  });

  it("renders only the token URL and token fields", async () => {
    setRemote({ enabled: true, authToken: "secret", allowedIps: ["100.64.0.0/10"] });

    render(<RemoteAccessModal />);

    expect(screen.getByText("URL + token")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(
      await screen.findByText("http://<laymux-host>:19281/remote/#token=secret"),
    ).toBeInTheDocument();
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(screen.queryByText(/LX_AUTOMATION_/)).not.toBeInTheDocument();
    expect(screen.queryByText("Allowed IPs")).not.toBeInTheDocument();
    expect(screen.queryByText("Controller")).not.toBeInTheDocument();
    expect(screen.queryByText("Local URL")).not.toBeInTheDocument();
  });

  it("copies the token URL and token", async () => {
    setRemote({ enabled: true, authToken: "secret" });

    render(<RemoteAccessModal />);

    await screen.findByText("http://<laymux-host>:19281/remote/#token=secret");

    const buttons = screen.getAllByRole("button", { name: "Copy" });
    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);

    expect(writeText).toHaveBeenNthCalledWith(1, "http://<laymux-host>:19281/remote/#token=secret");
    expect(writeText).toHaveBeenNthCalledWith(2, "secret");
  });
});
