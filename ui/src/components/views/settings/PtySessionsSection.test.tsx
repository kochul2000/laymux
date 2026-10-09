import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PtySessionsSection } from "./PtySessionsSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const CURRENT = "g3-000000000001";

const entry = (sessionId: string, state: string, attachEpoch = 1, daemon = CURRENT) => ({
  daemon,
  sessionId,
  terminalId: sessionId.split("#")[0],
  profile: "PowerShell",
  createdSeq: 1,
  childPid: 11,
  attachEpoch,
  state,
});

const inventory = {
  daemonRunning: true,
  currentDaemon: CURRENT,
  unavailableDaemons: [],
  sessions: [
    entry("pane-a#1-x", "pane"),
    entry("pane-w#1-z", "awaitingPane"),
    entry("pane-b#1-y", "detached", 4),
  ],
};

function respond(commands: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string) => {
    if (command in commands) {
      const value = commands[command];
      if (value instanceof Error) throw value.message;
      return value;
    }
    return undefined;
  });
}

/** Two clicks: the first arms the destructive action, the second runs it. */
function confirm(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByTestId(testId));
}

describe("PtySessionsSection", () => {
  beforeEach(() => invoke.mockReset());

  it("ends a detached session with its listed epoch, never a pane's or an awaited one", async () => {
    respond({ list_pty_sessions: inventory, terminate_pty_session: "terminated" });
    render(<PtySessionsSection />);

    await waitFor(() => expect(screen.getByTestId("pty-sessions-table")).toBeInTheDocument());
    // A pane's session ends with its pane; an unopened workspace's waits for it.
    expect(screen.queryByTestId("pty-session-end-pane-a#1-x")).toBeNull();
    expect(screen.queryByTestId("pty-session-end-pane-w#1-z")).toBeNull();

    // One click only arms the action.
    fireEvent.click(screen.getByTestId("pty-session-end-pane-b#1-y"));
    expect(invoke).not.toHaveBeenCalledWith("terminate_pty_session", expect.anything());
    fireEvent.click(screen.getByTestId("pty-session-end-pane-b#1-y"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminate_pty_session", {
        request: { daemon: CURRENT, sessionId: "pane-b#1-y", attachEpoch: 4 },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-notice")).toHaveTextContent(/ending|끝내는/),
    );
  });

  it("says when the session was re-adopted instead of ended", async () => {
    respond({ list_pty_sessions: inventory, terminate_pty_session: "superseded" });
    render(<PtySessionsSection />);
    await waitFor(() => expect(screen.getByTestId("pty-sessions-table")).toBeInTheDocument());
    confirm("pty-session-end-pane-b#1-y");
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-notice")).toHaveTextContent(
        /left running|그대로 두었습니다/,
      ),
    );
  });

  it("reports a daemon that does not answer instead of an empty list", async () => {
    respond({ list_pty_sessions: new Error("PTY daemon is running but does not answer") });
    render(<PtySessionsSection />);
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-summary")).toHaveTextContent("does not answer"),
    );
    expect(screen.queryByTestId("pty-sessions-table")).toBeNull();
    expect(screen.getByTestId("pty-sessions-end-detached")).toBeDisabled();
  });

  it("marks an earlier build's sessions and reports daemons it cannot list", async () => {
    respond({
      list_pty_sessions: {
        ...inventory,
        sessions: [...inventory.sessions, entry("pane-o#1-q", "detached", 2, "g3-0000000000aa")],
        unavailableDaemons: [
          { daemon: "g2-0000000000bb", problem: "incompatible", protocolVersion: 2 },
          { daemon: "g3-0000000000cc", problem: "notAnswering", protocolVersion: null },
        ],
      },
      terminate_pty_session: "terminated",
    });
    render(<PtySessionsSection />);
    await waitFor(() => expect(screen.getByTestId("pty-sessions-table")).toBeInTheDocument());
    const earlier = screen.getByTestId("pty-session-end-pane-o#1-q").closest("tr");
    expect(earlier).toHaveTextContent(/Previous build|이전 빌드/);
    expect(screen.getByTestId("pty-sessions-unavailable-g2-0000000000bb")).toHaveTextContent(
      "protocol 2",
    );
    expect(screen.getByTestId("pty-sessions-unavailable-g3-0000000000cc")).toHaveTextContent(
      "g3-0000000000cc",
    );

    // The session is ended through the daemon that runs it.
    confirm("pty-session-end-pane-o#1-q");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminate_pty_session", {
        request: { daemon: "g3-0000000000aa", sessionId: "pane-o#1-q", attachEpoch: 2 },
      }),
    );
  });

  it("ends every detached session at once and reports the ones that failed", async () => {
    respond({
      list_pty_sessions: inventory,
      terminate_detached_pty_sessions: { ended: 1, failed: ["pane-c: timed out"] },
    });
    render(<PtySessionsSection />);
    await waitFor(() => expect(screen.getByTestId("pty-sessions-end-detached")).toBeEnabled());
    confirm("pty-sessions-end-detached");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminate_detached_pty_sessions", {
        request: { sessions: [{ daemon: CURRENT, sessionId: "pane-b#1-y", attachEpoch: 4 }] },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pty-sessions-notice")).toHaveTextContent("pane-c: timed out"),
    );
  });
});
