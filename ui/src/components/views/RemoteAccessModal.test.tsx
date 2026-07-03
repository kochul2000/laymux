import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { useSettingsStore } from "@/stores/settings-store";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { useUiStore } from "@/stores/ui-store";
import { persistSession } from "@/lib/persist-session";
import { buildLocalMobileModeUrl, RemoteAccessModal } from "./RemoteAccessModal";

function setRemote(remote: Partial<ReturnType<typeof useSettingsStore.getState>["remote"]>) {
  useSettingsStore.getState().setRemote({
    enabled: false,
    bindAddress: "0.0.0.0",
    allowedOrigins: [],
    allowedIps: ["127.0.0.1/32", "::1/128"],
    authToken: "",
    heartbeatTimeoutSeconds: 15,
    autoMobileModeMinWidth: 720,
    ...remote,
  });
}

describe("RemoteAccessModal", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const mockPersistSession = vi.mocked(persistSession);

  const accessStatus = (runtimeEnabled = false) => {
    const remote = useSettingsStore.getState().remote;
    const token = remote.authToken || (runtimeEnabled ? "runtime-token" : "");
    return {
      effectiveEnabled: remote.enabled || runtimeEnabled,
      persistentEnabled: remote.enabled,
      runtimeEnabled,
      authTokenConfigured: token.length > 0,
      effectiveAuthToken: token,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "set_remote_runtime_access") return Promise.resolve(accessStatus(false));
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      if (cmd === "reclaim_remote_control") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    setRemote({});
    useRemoteAccessStore.setState(useRemoteAccessStore.getInitialState());
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
  });

  it("renders remote state, token URL, and token fields", async () => {
    setRemote({ enabled: true, authToken: "secret", allowedIps: ["100.64.0.0/10"] });

    render(<RemoteAccessModal />);

    expect(screen.getByText("URL + token")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(
      await screen.findByText("http://<laymux-host>:19281/remote/#token=secret"),
    ).toBeInTheDocument();
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(screen.queryByText(/LX_AUTOMATION_/)).not.toBeInTheDocument();
    expect(screen.getByText("Allowed IPs")).toBeInTheDocument();
    expect(screen.getByTestId("remote-allowed-ips-input")).toHaveValue("100.64.0.0/10");
    expect(screen.queryByText("Controller")).not.toBeInTheDocument();
    expect(screen.queryByText("Local URL")).not.toBeInTheDocument();
  });

  it("opens the PC app itself in local mobile mode", async () => {
    setRemote({ enabled: true, authToken: "secret" });

    render(<RemoteAccessModal />);

    await screen.findByText("http://<laymux-host>:19281/remote/#token=secret");
    await userEvent.click(screen.getByTestId("remote-mobile-mode-open"));

    expect(useLocalMobileModeStore.getState().active).toBe(true);
    expect(useLocalMobileModeStore.getState().url).toBe(buildLocalMobileModeUrl(19281, "secret"));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "set_remote_runtime_access")).toBe(false);
  });

  it("enables runtime remote access before opening local mobile mode when needed", async () => {
    setRemote({ enabled: false, authToken: "secret" });

    render(<RemoteAccessModal />);

    await screen.findByText("http://<laymux-host>:19281/remote/#token=secret");
    await userEvent.click(screen.getByTestId("remote-mobile-mode-open"));

    expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
      enabled: true,
      authToken: "secret",
    });
    expect(useLocalMobileModeStore.getState().url).toBe(buildLocalMobileModeUrl(19281, "secret"));
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

  it("offers host control reclaim when a remote controller owns the lease", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "set_remote_runtime_access") return Promise.resolve(accessStatus(false));
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: true, heartbeatTimeoutSeconds: 15 });
      }
      if (cmd === "reclaim_remote_control") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    setRemote({ enabled: true, authToken: "secret" });

    render(<RemoteAccessModal />);

    const reclaim = await screen.findByTestId("remote-access-reclaim");
    await userEvent.click(reclaim);

    expect(mockInvoke).toHaveBeenCalledWith("reclaim_remote_control");
    await vi.waitFor(() => {
      expect(screen.queryByTestId("remote-access-reclaim")).not.toBeInTheDocument();
    });
  });

  it("enables remote for this run without persisting settings", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus(false));
      if (cmd === "set_remote_runtime_access") {
        return Promise.resolve({
          effectiveEnabled: Boolean(args?.enabled),
          persistentEnabled: false,
          runtimeEnabled: Boolean(args?.enabled),
          authTokenConfigured: true,
          effectiveAuthToken: String(args?.authToken ?? "runtime-token"),
        });
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });

    render(<RemoteAccessModal />);

    await userEvent.click(await screen.findByTestId("remote-runtime-toggle"));

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_remote_runtime_access",
      expect.objectContaining({ enabled: true, authToken: expect.any(String) }),
    );
    expect(mockPersistSession).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().remote.enabled).toBe(false);
  });

  it("persists edited remote allowed IPs", async () => {
    setRemote({ authToken: "secret" });

    render(<RemoteAccessModal />);

    const input = (await screen.findByTestId("remote-allowed-ips-input")) as HTMLTextAreaElement;
    await userEvent.clear(input);
    await userEvent.type(input, "127.0.0.1/32{enter}100.64.0.0/10");
    await userEvent.click(screen.getByTestId("remote-allowed-ips-save"));

    expect(useSettingsStore.getState().remote.allowedIps).toEqual([
      "127.0.0.1/32",
      "100.64.0.0/10",
    ]);
    expect(mockPersistSession).toHaveBeenCalledTimes(1);
  });

  it("persists the automatic mobile mode width threshold", async () => {
    setRemote({ authToken: "secret", autoMobileModeMinWidth: 720 });

    render(<RemoteAccessModal />);

    const input = (await screen.findByTestId("remote-auto-mobile-width-input")) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    await userEvent.click(screen.getByTestId("remote-auto-mobile-width-save"));

    expect(useSettingsStore.getState().remote.autoMobileModeMinWidth).toBe(0);
    expect(mockPersistSession).toHaveBeenCalledTimes(1);
  });

  it("adds the Tailscale remote allowlist preset", async () => {
    setRemote({ authToken: "secret" });

    render(<RemoteAccessModal />);

    await userEvent.click(await screen.findByRole("button", { name: "Add Tailscale" }));
    await userEvent.click(screen.getByTestId("remote-allowed-ips-save"));

    expect(useSettingsStore.getState().remote.allowedIps).toEqual([
      "127.0.0.1/32",
      "::1/128",
      "100.64.0.0/10",
      "fd7a:115c:a1e0::/48",
    ]);
    expect(mockPersistSession).toHaveBeenCalledTimes(1);
  });

  it("enables remote on startup through persisted settings", async () => {
    setRemote({ authToken: "secret" });

    render(<RemoteAccessModal />);

    await userEvent.click(await screen.findByTestId("remote-persistent-toggle"));

    expect(useSettingsStore.getState().remote.enabled).toBe(true);
    expect(mockPersistSession).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
      enabled: false,
      authToken: null,
    });
  });
});
