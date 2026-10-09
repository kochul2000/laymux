import { invoke } from "@tauri-apps/api/core";

/**
 * Who holds a PTY daemon session (ADR-0306). `awaitingPane`: no client yet,
 * but the saved layout (an unopened workspace, a dock) will adopt it.
 */
export type PtySessionState = "pane" | "awaitingPane" | "detached" | "otherClient" | "ending";

export interface PtySessionEntry {
  sessionId: string;
  terminalId: string;
  profile: string | null;
  /** Daemon-wide creation order; larger is newer. */
  createdSeq: number;
  childPid: number | null;
  /** Must be passed back when ending the session, so one re-adopted since is kept. */
  attachEpoch: number;
  state: PtySessionState;
}

export interface PtySessionInventory {
  daemonRunning: boolean;
  sessions: PtySessionEntry[];
}

export type TerminateOutcome = "terminated" | "superseded" | "notDetached" | "gone";

export interface TerminateDetachedResult {
  ended: number;
  failed: string[];
}

export const listPtySessions = () => invoke<PtySessionInventory>("list_pty_sessions");

export const terminatePtySession = (entry: Pick<PtySessionEntry, "sessionId" | "attachEpoch">) =>
  invoke<TerminateOutcome>("terminate_pty_session", {
    request: { sessionId: entry.sessionId, attachEpoch: entry.attachEpoch },
  });

/** End the detached sessions the caller saw, each with the epoch it saw. */
export const terminateDetachedPtySessions = (
  entries: readonly Pick<PtySessionEntry, "sessionId" | "attachEpoch">[],
) =>
  invoke<TerminateDetachedResult>("terminate_detached_pty_sessions", {
    request: {
      sessions: entries.map(({ sessionId, attachEpoch }) => ({ sessionId, attachEpoch })),
    },
  });
