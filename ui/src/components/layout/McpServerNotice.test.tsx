import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerNotice } from "./McpServerNotice";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const failed = { phase: "failed", port: 19281, revision: 2, error: "bind: access denied" };
const running = { phase: "running", port: 19281, revision: 4, error: null };

describe("McpServerNotice", () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("reports a startup failure even though the HTTP server never came up", async () => {
    invoke.mockResolvedValue(failed);
    render(<McpServerNotice />);
    expect(await screen.findByRole("alert")).toHaveTextContent(failed.error);
    expect(invoke).toHaveBeenCalledWith("get_automation_server_status");
  });

  it("retries over native IPC, prevents duplicate clicks and explains client reconnection", async () => {
    let finish!: (value: typeof running) => void;
    invoke.mockResolvedValueOnce(failed).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<McpServerNotice />);
    const retry = await screen.findByTestId("mcp-server-retry");
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(invoke).toHaveBeenLastCalledWith("retry_automation_server");
    await act(async () => finish(running));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByTestId("mcp-server-retry")).toBeNull();
    fireEvent.click(screen.getByTestId("mcp-server-dismiss"));
    expect(screen.queryByTestId("mcp-server-notice")).toBeNull();
  });

  it("keeps the failure and retry available when recovery fails again", async () => {
    invoke.mockResolvedValueOnce(failed).mockResolvedValueOnce({ ...failed, revision: 4 });
    render(<McpServerNotice />);
    fireEvent.click(await screen.findByTestId("mcp-server-retry"));
    await waitFor(() => expect(screen.getByTestId("mcp-server-retry")).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent(failed.error);
  });

  it("detects a later failure through native IPC polling", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce(running).mockResolvedValue({ ...failed, revision: 5 });
    render(<McpServerNotice />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(failed.error);
  });

  it("shows IPC errors instead of silently hiding an unknown server state", async () => {
    invoke.mockRejectedValue(new Error("native status unavailable"));
    render(<McpServerNotice />);
    expect(await screen.findByRole("alert")).toHaveTextContent("native status unavailable");
    expect(screen.getByTestId("mcp-server-retry")).toBeEnabled();
  });

  it("ignores an older failed poll that completes after recovery", async () => {
    vi.useFakeTimers();
    let finishPoll!: (value: typeof failed) => void;
    invoke
      .mockResolvedValueOnce(failed)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPoll = resolve;
          }),
      )
      .mockResolvedValueOnce(running);
    render(<McpServerNotice />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-server-retry"));
    });
    await act(async () => finishPoll(failed));
    expect(screen.getByRole("status")).toHaveTextContent("Reconnect MCP");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
