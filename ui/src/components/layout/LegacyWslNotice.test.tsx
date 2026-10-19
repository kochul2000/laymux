import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyWslNotice } from "./LegacyWslNotice";
import { useTerminalStore } from "@/stores/terminal-store";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function readyTerminal(id: string) {
  act(() => {
    useTerminalStore.getState().registerInstance({
      id,
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws",
    });
    useTerminalStore.setState((s) => ({
      instances: s.instances.map((i) => (i.id === id ? { ...i, sessionReady: true } : i)),
    }));
  });
}

describe("LegacyWslNotice", () => {
  beforeEach(() => {
    invoke.mockReset();
    useTerminalStore.setState({ instances: [] });
  });

  it("warns once the backend reports the legacy WSL client in use", async () => {
    invoke.mockResolvedValue(true);
    render(<LegacyWslNotice />);
    expect(await screen.findByTestId("legacy-wsl-notice")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("get_legacy_wsl_notice");
  });

  it("stays hidden while the backend reports no legacy use", async () => {
    invoke.mockResolvedValue(false);
    render(<LegacyWslNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("legacy-wsl-notice")).toBeNull();
  });

  it("asks again when a terminal session becomes ready", async () => {
    // WSL use starts with a WSL-backed session, which the backend only knows
    // once the PTY exists.
    invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<LegacyWslNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    readyTerminal("t1");
    expect(await screen.findByTestId("legacy-wsl-notice")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("closes for the rest of the run and stops asking", async () => {
    invoke.mockResolvedValue(true);
    render(<LegacyWslNotice />);
    fireEvent.click(await screen.findByTestId("legacy-wsl-notice-dismiss"));
    expect(screen.queryByTestId("legacy-wsl-notice")).toBeNull();
    readyTerminal("t2");
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("legacy-wsl-notice")).toBeNull();
  });

  it("stays hidden when the check fails", async () => {
    invoke.mockRejectedValue(new Error("ipc down"));
    render(<LegacyWslNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("legacy-wsl-notice")).toBeNull();
  });
});
