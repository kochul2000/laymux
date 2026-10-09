import { invoke } from "@tauri-apps/api/core";

/** Who holds a PTY daemon session (ADR-0306). */
export type PtySessionState = "pane" | "detached" | "otherClient" | "ending";

export interface PtySessionEntry {
  sessionId: string;
  terminalId: string;
  childPid: number | null;
  /** Must be passed back when ending the session, so one re-adopted since is kept. */
  attachEpoch: number;
  state: PtySessionState;
}

export interface PtySessionInventory {
  daemonRunning: boolean;
  sessions: PtySessionEntry[];
}

export type TerminateOutcome = "terminated" | "superseded" | "gone";

export const listPtySessions = () => invoke<PtySessionInventory>("list_pty_sessions");

export const terminatePtySession = (entry: Pick<PtySessionEntry, "sessionId" | "attachEpoch">) =>
  invoke<TerminateOutcome>("terminate_pty_session", {
    request: { sessionId: entry.sessionId, attachEpoch: entry.attachEpoch },
  });

export const terminateDetachedPtySessions = () => invoke<number>("terminate_detached_pty_sessions");
