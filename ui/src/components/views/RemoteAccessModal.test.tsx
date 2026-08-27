import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useSettingsStore } from "@/stores/settings-store";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { useUiStore } from "@/stores/ui-store";
import { buildLocalMobileModeUrl, REMOTE_LAST_HOST_KEY } from "@/lib/remote-hosts";
import { RemoteAccessModal } from "./RemoteAccessModal";

function setRemote(remote: Partial<ReturnType<typeof useSettingsStore.getState>["remote"]>) {
  useSettingsStore.getState().setRemote({
    enabled: false,
    bindAddress: "0.0.0.0",
    allowedOrigins: [],
    allowedIps: ["127.0.0.1/32", "::1/128"],
    authToken: "",
    heartbeatTimeoutSeconds: 15,
    autoMobileModeMinWidth: 720,
    preferredHost: "",
    customHosts: [],
    cloudEnabled: false,
    cloudInstanceId: null,
    cloudTunnelUrl: null,
    cloudServerBaseUrl: null,
    ...remote,
  });
}

describe("RemoteAccessModal", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  const hostCandidates = [
    { kind: "tailscale", host: "100.64.0.2", label: "Tailscale 100.64.0.2" },
    { kind: "lan", host: "192.168.0.44", label: "LAN 192.168.0.44" },
    { kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" },
  ];

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
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_android_pairing_status") {
        return Promise.resolve({
          paired: false,
          phase: "none",
          endpoint: null,
          instanceId: null,
          expiresAt: null,
          confirmedAt: null,
        });
      }
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
    localStorage.clear();
  });

  it("renders remote state, host selector, token URL, and token fields", async () => {
    setRemote({ enabled: true, authToken: "secret", preferredHost: "100.64.0.2" });

    render(<RemoteAccessModal />);

    const select = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    expect(select.value).toBe("100.64.0.2");
    expect(screen.getByText("URL + token")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(screen.getByText("http://100.64.0.2:19281/remote/#token=secret")).toBeInTheDocument();
    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(screen.queryByText("Allowed IPs")).not.toBeInTheDocument();
    expect(screen.queryByText("Auto mobile width")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-persistent-toggle")).not.toBeInTheDocument();
  });

  it("updates the copy URL when the selected host changes", async () => {
    setRemote({ enabled: true, authToken: "secret" });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    const select = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    expect(select.value).toBe("100.64.0.2");
    await user.selectOptions(select, "192.168.0.44");

    expect(screen.getByText("http://192.168.0.44:19281/remote/#token=secret")).toBeInTheDocument();
  });

  it("remembers the selected host for automatic host selection across modal mounts", async () => {
    setRemote({ enabled: true, authToken: "secret", preferredHost: "" });
    const user = userEvent.setup();
    const { unmount } = render(<RemoteAccessModal />);

    const select = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    expect(select.value).toBe("100.64.0.2");
    await user.selectOptions(select, "192.168.0.44");

    expect(localStorage.getItem(REMOTE_LAST_HOST_KEY)).toBe("192.168.0.44");
    expect(screen.getByText("http://192.168.0.44:19281/remote/#token=secret")).toBeInTheDocument();

    unmount();
    render(<RemoteAccessModal />);

    const remountedSelect = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    expect(remountedSelect.value).toBe("192.168.0.44");
    expect(screen.getByText("http://192.168.0.44:19281/remote/#token=secret")).toBeInTheDocument();
  });

  it("uses the explicit preferred host before the remembered automatic host", async () => {
    localStorage.setItem(REMOTE_LAST_HOST_KEY, "192.168.0.44");
    setRemote({ enabled: true, authToken: "secret", preferredHost: "100.64.0.2" });

    render(<RemoteAccessModal />);

    const select = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    expect(select.value).toBe("100.64.0.2");
    expect(screen.getByText("http://100.64.0.2:19281/remote/#token=secret")).toBeInTheDocument();
  });

  it("falls back to the resolved host when the picked host leaves the candidate list", async () => {
    setRemote({ enabled: true, authToken: "secret", customHosts: ["box.internal"] });
    const user = userEvent.setup();

    const { rerender } = render(<RemoteAccessModal />);

    const select = (await screen.findByTestId("remote-host-select")) as HTMLSelectElement;
    await user.selectOptions(select, "box.internal");
    expect(screen.getByText("http://box.internal:19281/remote/#token=secret")).toBeInTheDocument();

    // The custom host is removed from settings — the picked value is now stale
    // and the selector must re-home on the resolved default.
    setRemote({ enabled: true, authToken: "secret", customHosts: [] });
    rerender(<RemoteAccessModal />);

    await waitFor(() => {
      expect((screen.getByTestId("remote-host-select") as HTMLSelectElement).value).toBe(
        "100.64.0.2",
      );
    });
    expect(screen.getByText("http://100.64.0.2:19281/remote/#token=secret")).toBeInTheDocument();
  });

  it("brackets IPv6 hosts in the copy URL", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") {
        return Promise.resolve([
          { kind: "loopback", host: "127.0.0.1", label: "Localhost 127.0.0.1" },
          { kind: "tailscale", host: "fd7a:115c:a1e0::7", label: "Tailscale fd7a:115c:a1e0::7" },
        ]);
      }
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    setRemote({ enabled: true, authToken: "secret", preferredHost: "fd7a:115c:a1e0::7" });

    render(<RemoteAccessModal />);

    expect(
      await screen.findByText("http://[fd7a:115c:a1e0::7]:19281/remote/#token=secret"),
    ).toBeInTheDocument();
  });

  it("copies the selected token URL and token", async () => {
    setRemote({ enabled: true, authToken: "secret", preferredHost: "100.64.0.2" });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<RemoteAccessModal />);

    await screen.findByText("http://100.64.0.2:19281/remote/#token=secret");

    const buttons = screen.getAllByRole("button", { name: "Copy" });
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    await user.click(buttons[0]);
    await user.click(buttons[1]);

    expect(writeText).toHaveBeenNthCalledWith(1, "http://100.64.0.2:19281/remote/#token=secret");
    expect(writeText).toHaveBeenNthCalledWith(2, "secret");
  });

  it("opens the PC app itself in local mobile mode", async () => {
    setRemote({ enabled: true, authToken: "secret" });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    await screen.findByText("http://100.64.0.2:19281/remote/#token=secret");
    await user.click(screen.getByTestId("remote-mobile-mode-open"));

    expect(useLocalMobileModeStore.getState().active).toBe(true);
    expect(useLocalMobileModeStore.getState().url).toBe(buildLocalMobileModeUrl(19281, "secret"));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "set_remote_runtime_access")).toBe(false);
  });

  it("enables runtime remote access before opening local mobile mode when needed", async () => {
    setRemote({ enabled: false, authToken: "secret" });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    await screen.findByText("http://100.64.0.2:19281/remote/#token=secret");
    await user.click(screen.getByTestId("remote-mobile-mode-open"));

    expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
      enabled: true,
      authToken: "secret",
    });
    expect(useLocalMobileModeStore.getState().url).toBe(buildLocalMobileModeUrl(19281, "secret"));
  });

  it("disables the runtime switch while mobile mode is opening", async () => {
    let resolveRuntimeAccess: (value: ReturnType<typeof accessStatus>) => void = () => {};
    const runtimeAccessPromise = new Promise<ReturnType<typeof accessStatus>>((resolve) => {
      resolveRuntimeAccess = resolve;
    });
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus(false));
      if (cmd === "set_remote_runtime_access") {
        expect(args).toEqual({ enabled: true, authToken: "secret" });
        return runtimeAccessPromise;
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    setRemote({ enabled: false, authToken: "secret" });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    const toggle = (await screen.findByTestId("remote-runtime-toggle")) as HTMLInputElement;
    const mobileButton = await screen.findByTestId("remote-mobile-mode-open");
    await waitFor(() => expect(mobileButton).not.toBeDisabled());
    expect(toggle).not.toBeDisabled();
    await user.click(mobileButton);

    await waitFor(() => expect(toggle).toBeDisabled());

    resolveRuntimeAccess({
      effectiveEnabled: true,
      persistentEnabled: false,
      runtimeEnabled: true,
      authTokenConfigured: true,
      effectiveAuthToken: "secret",
    });
    await waitFor(() => expect(useLocalMobileModeStore.getState().active).toBe(true));
  });

  it("offers host control reclaim when a remote controller owns the lease", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
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
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    const reclaim = await screen.findByTestId("remote-access-reclaim");
    await user.click(reclaim);

    expect(mockInvoke).toHaveBeenCalledWith("reclaim_remote_control");
    await vi.waitFor(() => {
      expect(screen.queryByTestId("remote-access-reclaim")).not.toBeInTheDocument();
    });
  });

  it("enables remote for this run with the runtime switch without persisting settings", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
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
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    const toggle = (await screen.findByTestId("remote-runtime-toggle")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);

    expect(mockInvoke).toHaveBeenCalledWith(
      "set_remote_runtime_access",
      expect.objectContaining({ enabled: true, authToken: expect.any(String) }),
    );
    await waitFor(() => {
      expect(useRemoteAccessStore.getState().status).toMatchObject({
        effectiveEnabled: true,
        persistentEnabled: false,
        runtimeEnabled: true,
      });
      expect(toggle.checked).toBe(true);
    });
    expect(useSettingsStore.getState().remote.enabled).toBe(false);
  });

  it("disables remote for this run with the runtime switch", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") {
        return Promise.resolve({
          effectiveEnabled: true,
          persistentEnabled: false,
          runtimeEnabled: true,
          authTokenConfigured: true,
          effectiveAuthToken: "runtime-token",
        });
      }
      if (cmd === "set_remote_runtime_access") {
        const enabled = Boolean(args?.enabled);
        const token = typeof args?.authToken === "string" ? args.authToken : "";
        return Promise.resolve({
          effectiveEnabled: enabled,
          persistentEnabled: false,
          runtimeEnabled: enabled,
          authTokenConfigured: token.length > 0,
          effectiveAuthToken: token,
        });
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);

    const toggle = (await screen.findByTestId("remote-runtime-toggle")) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    await user.click(toggle);

    expect(mockInvoke).toHaveBeenCalledWith("set_remote_runtime_access", {
      enabled: false,
      authToken: null,
    });
    await waitFor(() => {
      expect(useRemoteAccessStore.getState().status).toMatchObject({
        effectiveEnabled: false,
        persistentEnabled: false,
        runtimeEnabled: false,
      });
      expect(toggle.checked).toBe(false);
    });
  });

  it("requires a cloud identity before generating an Android pairing value", async () => {
    render(<RemoteAccessModal />);

    expect(await screen.findByTestId("android-pairing-section")).toBeInTheDocument();
    expect(screen.getByTestId("android-pairing-generate")).toBeDisabled();
    expect(screen.getByText("Connect Cloud Remote before creating a pairing value.")).toBeVisible();
  });

  it("creates an Android invitation and copies its payload without rendering the secret", async () => {
    setRemote({
      cloudEnabled: true,
      cloudInstanceId: "instance-1",
      cloudServerBaseUrl: "https://relay.example.test",
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_android_pairing_status") {
        return Promise.resolve({
          paired: false,
          phase: "none",
          endpoint: null,
          instanceId: null,
          expiresAt: null,
          confirmedAt: null,
        });
      }
      if (cmd === "create_android_pairing_qr") {
        return Promise.resolve({
          status: {
            paired: true,
            phase: "pending",
            endpoint: "https://relay.example.test/",
            instanceId: "instance-1",
            expiresAt: 4_102_444_800,
            confirmedAt: null,
          },
          qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>',
          pairingPayload:
            "laymux://pair/v2?endpoint=https%3A%2F%2Frelay.example.test%2F&secret=copy-me",
        });
      }
      if (cmd === "revoke_android_pairing") {
        return new Promise(() => {});
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<RemoteAccessModal />);
    await user.click(await screen.findByTestId("android-pairing-generate"));

    expect(mockInvoke).toHaveBeenCalledWith("create_android_pairing_qr");
    const qr = await screen.findByRole("img", { name: "Android pairing QR code" });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(/Pairing value issued · waiting for app confirmation/)).toBeVisible();
    expect(screen.getByText(/clipboard history or device sync/)).toBeVisible();
    await user.click(screen.getByTestId("android-pairing-copy"));
    expect(writeText).toHaveBeenCalledWith(
      "laymux://pair/v2?endpoint=https%3A%2F%2Frelay.example.test%2F&secret=copy-me",
    );
    expect(document.body.textContent).not.toContain("laymux://pair/v2");
    expect(document.body.textContent).not.toContain("secret=");
    await user.click(screen.getByTestId("android-pairing-revoke"));
    expect(screen.queryByTestId("android-pairing-copy")).toBeNull();
    expect(screen.queryByRole("img", { name: "Android pairing QR code" })).toBeNull();
  });

  it("hides the previous invitation while a replacement request is pending", async () => {
    setRemote({
      cloudEnabled: true,
      cloudInstanceId: "instance-1",
      cloudServerBaseUrl: "https://relay.example.test",
    });
    let createCount = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_android_pairing_status") {
        return Promise.resolve({
          paired: false,
          phase: "none",
          endpoint: null,
          instanceId: null,
          expiresAt: null,
          confirmedAt: null,
        });
      }
      if (cmd === "create_android_pairing_qr") {
        createCount += 1;
        if (createCount > 1) return new Promise(() => {});
        return Promise.resolve({
          status: {
            paired: true,
            phase: "pending",
            endpoint: "https://relay.example.test/",
            instanceId: "instance-1",
            expiresAt: 4_102_444_800,
            confirmedAt: null,
          },
          qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" />',
          pairingPayload:
            "laymux://pair/v2?endpoint=https%3A%2F%2Frelay.example.test%2F&secret=old-value",
        });
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);
    const generate = await screen.findByTestId("android-pairing-generate");
    await user.click(generate);
    expect(await screen.findByTestId("android-pairing-copy")).toBeVisible();

    await user.click(generate);

    expect(screen.queryByTestId("android-pairing-copy")).toBeNull();
    expect(screen.queryByRole("img", { name: "Android pairing QR code" })).toBeNull();
  });

  it("does not let a delayed initial status overwrite a generated Android pairing", async () => {
    setRemote({
      cloudEnabled: true,
      cloudInstanceId: "instance-1",
      cloudServerBaseUrl: "https://relay.example.test",
    });
    let resolveStatus!: (status: {
      paired: boolean;
      phase: "none";
      endpoint: null;
      instanceId: null;
    }) => void;
    const delayedStatus = new Promise<{
      paired: boolean;
      phase: "none";
      endpoint: null;
      instanceId: null;
    }>((resolve) => {
      resolveStatus = resolve;
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_android_pairing_status") return delayedStatus;
      if (cmd === "create_android_pairing_qr") {
        return Promise.resolve({
          status: {
            paired: true,
            phase: "pending",
            endpoint: "https://relay.example.test/",
            instanceId: "instance-1",
            expiresAt: 4_102_444_800,
            confirmedAt: null,
          },
          qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" />',
          pairingPayload:
            "laymux://pair/v2?endpoint=https%3A%2F%2Frelay.example.test%2F&secret=copy-me",
        });
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);
    const generate = await screen.findByTestId("android-pairing-generate");
    await user.click(generate);
    expect(await screen.findByRole("img", { name: "Android pairing QR code" })).toBeVisible();
    expect(screen.getByTestId("android-pairing-revoke")).toBeVisible();

    resolveStatus({ paired: false, phase: "none", endpoint: null, instanceId: null });

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_android_pairing_status"));
    expect(screen.getByTestId("android-pairing-revoke")).toBeVisible();
  });

  it("revokes the stored Android pairing", async () => {
    setRemote({
      cloudEnabled: true,
      cloudInstanceId: "instance-1",
      cloudServerBaseUrl: "https://relay.example.test",
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_automation_info") return Promise.resolve({ port: 19281 });
      if (cmd === "get_remote_host_candidates") return Promise.resolve(hostCandidates);
      if (cmd === "get_remote_access_status") return Promise.resolve(accessStatus());
      if (cmd === "get_android_pairing_status") {
        return Promise.resolve({
          paired: true,
          phase: "confirmed",
          endpoint: "https://relay.example.test/",
          instanceId: "instance-1",
          expiresAt: 4_102_444_800,
          confirmedAt: 1_786_500_000,
        });
      }
      if (cmd === "revoke_android_pairing") {
        return Promise.resolve({
          paired: false,
          phase: "none",
          endpoint: null,
          instanceId: null,
          expiresAt: null,
          confirmedAt: null,
        });
      }
      if (cmd === "get_remote_control_status") {
        return Promise.resolve({ active: false, heartbeatTimeoutSeconds: 15 });
      }
      return Promise.resolve(null);
    });
    const user = userEvent.setup();

    render(<RemoteAccessModal />);
    await user.click(await screen.findByTestId("android-pairing-revoke"));

    expect(mockInvoke).toHaveBeenCalledWith("revoke_android_pairing");
    await waitFor(() => expect(screen.queryByTestId("android-pairing-revoke")).toBeNull());
  });
});
