import { describe, it, expect } from "vitest";
import { resolveSyncCwd, DEFAULT_SYNC_CWD_DEFAULTS } from "./sync-cwd-config";

describe("resolveSyncCwd", () => {
  // --- Basic resolution ---

  it("returns workspace defaults when no profile override", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "workspace",
      profiles: [{ name: "WSL" }],
    });
    expect(result).toEqual({ send: true, receive: true });
  });

  it("returns dock defaults when no profile override", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "dock",
      profiles: [{ name: "WSL" }],
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  // --- Profile override ---

  it("uses profile syncCwd object when specified", () => {
    const result = resolveSyncCwd({
      profileName: "Monitor",
      location: "workspace",
      profiles: [{ name: "Monitor", syncCwd: { send: false, receive: false } }],
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  it('profile syncCwd "default" delegates to location defaults', () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "dock",
      profiles: [{ name: "WSL", syncCwd: "default" }],
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  // --- profileDefaults override ---

  it("uses profileDefaults.syncCwd when profile has no override", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "workspace",
      profiles: [{ name: "WSL" }],
      profileDefaultsSyncCwd: { send: true, receive: false },
    });
    expect(result).toEqual({ send: true, receive: false });
  });

  it('profileDefaults.syncCwd "default" delegates to location defaults', () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "dock",
      profiles: [{ name: "WSL" }],
      profileDefaultsSyncCwd: "default",
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  // --- Priority chain: profile > profileDefaults > syncCwdDefaults ---

  it("profile overrides profileDefaults", () => {
    const result = resolveSyncCwd({
      profileName: "Monitor",
      location: "workspace",
      profiles: [{ name: "Monitor", syncCwd: { send: false, receive: false } }],
      profileDefaultsSyncCwd: { send: true, receive: true },
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  it("profileDefaults overrides syncCwdDefaults", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "workspace",
      profiles: [{ name: "WSL" }],
      profileDefaultsSyncCwd: { send: false, receive: true },
      syncCwdDefaults: {
        workspace: { send: true, receive: true },
        dock: { send: false, receive: false },
      },
    });
    expect(result).toEqual({ send: false, receive: true });
  });

  // --- Custom syncCwdDefaults ---

  it("uses custom syncCwdDefaults for workspace", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "workspace",
      profiles: [{ name: "WSL" }],
      syncCwdDefaults: {
        workspace: { send: true, receive: false },
        dock: { send: false, receive: false },
      },
    });
    expect(result).toEqual({ send: true, receive: false });
  });

  it("uses custom syncCwdDefaults for dock", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "dock",
      profiles: [{ name: "WSL" }],
      syncCwdDefaults: {
        workspace: { send: true, receive: true },
        dock: { send: true, receive: false },
      },
    });
    expect(result).toEqual({ send: true, receive: false });
  });

  // --- Edge cases ---

  it("returns location defaults when profile not found", () => {
    const result = resolveSyncCwd({
      profileName: "NonExistent",
      location: "workspace",
      profiles: [],
    });
    expect(result).toEqual({ send: true, receive: true });
  });

  it("returns location defaults when profiles is undefined", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "dock",
    });
    expect(result).toEqual({ send: false, receive: false });
  });

  it("handles undefined syncCwd on profile (same as no override)", () => {
    const result = resolveSyncCwd({
      profileName: "WSL",
      location: "workspace",
      profiles: [{ name: "WSL", syncCwd: undefined }],
    });
    expect(result).toEqual({ send: true, receive: true });
  });
});

describe("DEFAULT_SYNC_CWD_DEFAULTS", () => {
  it("has correct workspace defaults", () => {
    expect(DEFAULT_SYNC_CWD_DEFAULTS.workspace).toEqual({ send: true, receive: true });
  });

  it("has correct dock defaults", () => {
    expect(DEFAULT_SYNC_CWD_DEFAULTS.dock).toEqual({ send: false, receive: false });
  });
});
