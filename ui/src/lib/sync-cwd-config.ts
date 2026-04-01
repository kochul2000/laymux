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

/** Profile shape used for resolution (subset of full Profile). */
export interface SyncCwdProfileInfo {
  name: string;
  syncCwd?: SyncCwdConfig;
}

export const DEFAULT_SYNC_CWD_DEFAULTS: SyncCwdDefaults = {
  workspace: { send: true, receive: true },
  dock: { send: false, receive: false },
};

export interface ResolveSyncCwdParams {
  profileName: string;
  location: TerminalLocation;
  profiles?: SyncCwdProfileInfo[];
  profileDefaultsSyncCwd?: SyncCwdConfig;
  syncCwdDefaults?: SyncCwdDefaults;
}

/**
 * Resolve the final { send, receive } for a terminal based on its profile and location.
 */
export function resolveSyncCwd(params: ResolveSyncCwdParams): SyncCwdPair {
  const {
    profileName,
    location,
    profiles,
    profileDefaultsSyncCwd,
    syncCwdDefaults = DEFAULT_SYNC_CWD_DEFAULTS,
  } = params;

  const locationDefault = syncCwdDefaults[location];

  // Step 1: Check individual profile
  const profile = profiles?.find((p) => p.name === profileName);
  if (profile?.syncCwd != null && profile.syncCwd !== "default") {
    return profile.syncCwd;
  }

  // Step 2: Check profileDefaults
  if (profileDefaultsSyncCwd != null && profileDefaultsSyncCwd !== "default") {
    return profileDefaultsSyncCwd;
  }

  // Step 3: Location defaults
  return locationDefault;
}
