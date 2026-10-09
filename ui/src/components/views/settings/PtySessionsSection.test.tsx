import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PtySessionsSection } from "./PtySessionsSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const inventory = {
  daemonRunning: true,
  sessions: [
    {
      sessionId: "pane-a#1-x",
      terminalId: "pane-a",
      childPid: 11,
      attachEpoch: 1,
      state: "pane",
    },
    {
      sessionId: "pane-b#1-y",
      terminalId: "pane-b",
      childPid: 22,
      attachEpoch: 4,
      state: "detached",
    },
  ],
};

describe("PtySessionsSection", () => {
  beforeEach(() => invoke.mockReset());

  it("ends a detached session with the epoch it was listed with, never a pane's", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_pty_sessions") return inventory;
      if (command === "terminate_pty_session") return "terminated";
      return undefined;
    });
    render(<PtySessionsSection />);

    await waitFor(() => expect(screen.getByTestId("pty-sessions-table")).toBeInTheDocument());
    // Only the detached session can be ended here; a pane's ends with its pane.
    expect(screen.queryByTestId("pty-session-end-pane-a#1-x")).toBeNull();
    fireEvent.click(screen.getByTestId("pty-session-end-pane-b#1-y"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminate_pty_session", {
        request: { sessionId: "pane-b#1-y", attachEpoch: 4 },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-notice")).toHaveTextContent(/ending|끝내는/),
    );
  });

  it("reports a daemon that does not answer instead of an empty list", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_pty_sessions") throw "PTY daemon did not list its sessions: timed out";
      return undefined;
    });
    render(<PtySessionsSection />);
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-summary")).toHaveTextContent("timed out"),
    );
    expect(screen.queryByTestId("pty-sessions-table")).toBeNull();
    expect(screen.getByTestId("pty-sessions-end-detached")).toBeDisabled();
  });

  it("ends every detached session at once", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "list_pty_sessions") return inventory;
      if (command === "terminate_detached_pty_sessions") return 1;
      return undefined;
    });
    render(<PtySessionsSection />);
    await waitFor(() => expect(screen.getByTestId("pty-sessions-end-detached")).toBeEnabled());
    fireEvent.click(screen.getByTestId("pty-sessions-end-detached"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminate_detached_pty_sessions"));
  });
});
