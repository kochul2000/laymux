/**
 * CWD sync configuration resolution.
 *
 * Resolution priority (highest → lowest):
 *   1. Individual profile `syncCwd`
 *   2. `profileDefaults.syncCwd`
 *   3. Location-based `syncCwdDefaults` (workspace / dock)
 *
 * A value of `"default"` at any level means "delegate to the next level".
 */

/** Resolved send/receive pair. */
export interface SyncCwdPair {
  send: boolean;
  receive: boolean;
}

/** A syncCwd config value: either a concrete pair or "default" (delegate). */
export type SyncCwdConfig = "default" | SyncCwdPair;

/** Location-based defaults for workspace and dock. */
export interface SyncCwdDefaults {
  workspace: SyncCwdPair;
  dock: SyncCwdPair;
}

/** Terminal location context. */
export type TerminalLocation = "workspace" | "dock";

export const DEFAULT_SYNC_CWD_DEFAULTS: SyncCwdDefaults = {
  workspace: { send: true, receive: true },
  dock: { send: false, receive: false },
};

export interface ResolveSyncCwdParams {
  /** Kept for caller context / debugging — not used in resolution logic. */
  profileName?: string;
  location: TerminalLocation;
  /** The syncCwd value from the matching profile (already looked up by caller). */
  profileSyncCwd?: SyncCwdConfig;
  profileDefaultsSyncCwd?: SyncCwdConfig;
  syncCwdDefaults?: SyncCwdDefaults;
}

/**
 * Resolve the final { send, receive } for a terminal based on its profile and location.
 */
export function resolveSyncCwd(params: ResolveSyncCwdParams): SyncCwdPair {
  const {
    location,
    profileSyncCwd,
    profileDefaultsSyncCwd,
    syncCwdDefaults = DEFAULT_SYNC_CWD_DEFAULTS,
  } = params;

  const locationDefault = syncCwdDefaults[location];

  // Step 1: Check individual profile
  if (profileSyncCwd != null && profileSyncCwd !== "default") {
    return profileSyncCwd;
  }

  // Step 2: Check profileDefaults
  if (profileDefaultsSyncCwd != null && profileDefaultsSyncCwd !== "default") {
    return profileDefaultsSyncCwd;
  }

  // Step 3: Location defaults
  return locationDefault;
}
