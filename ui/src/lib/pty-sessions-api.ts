import { invoke } from "@tauri-apps/api/core";

/**
 * Who holds a PTY daemon session (ADR-0306). `awaitingPane`: no client yet,
 * but the saved layout (an unopened workspace, a dock) will adopt it.
 */
export type PtySessionState = "pane" | "awaitingPane" | "detached" | "otherClient" | "ending";

export interface PtySessionEntry {
  /** The daemon generation (one per build, ADR-0308) that runs it. */
  daemon: string;
  sessionId: string;
  terminalId: string;
  profile: string | null;
  /** Creation order within its daemon; larger is newer. */
  createdSeq: number;
  childPid: number | null;
  /** Must be passed back when ending the session, so one re-adopted since is kept. */
  attachEpoch: number;
  state: PtySessionState;
}

/** A live daemon generation whose sessions could not be listed. */
export interface UnavailableDaemon {
  daemon: string;
  problem: "notAnswering" | "incompatible";
  protocolVersion: number | null;
}

export interface PtySessionInventory {
  daemonRunning: boolean;
  /** This build's generation; sessions of any other run on an earlier build. */
  currentDaemon: string | null;
  sessions: PtySessionEntry[];
  unavailableDaemons: UnavailableDaemon[];
}

export type TerminateOutcome = "terminated" | "superseded" | "notDetached" | "gone";

export interface TerminateDetachedResult {
  ended: number;
  failed: string[];
}

type ListedSession = Pick<PtySessionEntry, "daemon" | "sessionId" | "attachEpoch">;

const listed = ({ daemon, sessionId, attachEpoch }: ListedSession) => ({
  daemon,
  sessionId,
  attachEpoch,
});

export const listPtySessions = () => invoke<PtySessionInventory>("list_pty_sessions");

export const terminatePtySession = (entry: ListedSession) =>
  invoke<TerminateOutcome>("terminate_pty_session", { request: listed(entry) });

/** End the detached sessions the caller saw, each with the epoch it saw. */
export const terminateDetachedPtySessions = (entries: readonly ListedSession[]) =>
  invoke<TerminateDetachedResult>("terminate_detached_pty_sessions", {
    request: { sessions: entries.map(listed) },
  });
