import { beforeEach, expect, it, vi } from "vitest";
import type { Settings } from "./tauri-api";

vi.mock("./settings-snapshot", () => ({ collectSessionCheckpoint: vi.fn() }));
vi.mock("./local-session", () => ({ saveLocalSession: vi.fn() }));
vi.mock("./session-checkpoint-receipt", () => ({
  captureSessionReceipt: vi.fn().mockResolvedValue("capture"),
  commitSessionReceipt: vi.fn().mockResolvedValue("receipt"),
}));
vi.mock("@/lib/tauri-api", () => ({ saveSettings: vi.fn() }));
import { collectSessionCheckpoint } from "./settings-snapshot";
import { saveLocalSession } from "./local-session";
import {
  _resetClosingDown,
  flushSessionCheckpoint,
  getReusableSessionCheckpointCommit,
  markSessionDisplayMutation,
} from "./persist-session";
import { setBlockPersist } from "./settings-write-guard";

beforeEach(() => {
  vi.clearAllMocks();
  _resetClosingDown();
  setBlockPersist(false);
});

it("commits despite continuous display animation, while invalidating reuse after the captured display changes", async () => {
  const settings = { workspaces: [], docks: [] } as unknown as Settings;
  vi.mocked(collectSessionCheckpoint).mockImplementation(async () => {
    markSessionDisplayMutation();
    return { settings, coverage: [], cwdLookupFailed: false, attributionLookupFailed: false };
  });
  vi.mocked(saveLocalSession).mockImplementation(async () => {
    // A title animation lands while the SQLite write is in flight, on every save.
    markSessionDisplayMutation();
    return {
      revision: 1,
      needsRetry: false,
      unresolvedTerminalIds: [],
      snapshot: {
        workspaces: [],
        docks: [],
        coverage: [],
        cwdLookupFailed: false,
        attributionLookupFailed: false,
      },
    };
  });
  await flushSessionCheckpoint({ reason: "update" });
  expect(collectSessionCheckpoint).toHaveBeenCalledTimes(1);
  expect(saveLocalSession).toHaveBeenCalledTimes(1);
  expect(getReusableSessionCheckpointCommit()).toBeUndefined();

  vi.mocked(saveLocalSession).mockImplementation(async () => ({
    revision: 2,
    needsRetry: false,
    unresolvedTerminalIds: [],
    snapshot: {
      workspaces: [],
      docks: [],
      coverage: [],
      cwdLookupFailed: false,
      attributionLookupFailed: false,
    },
  }));
  const stable = await flushSessionCheckpoint();
  expect(getReusableSessionCheckpointCommit()).toBe(stable);
  markSessionDisplayMutation();
  expect(getReusableSessionCheckpointCommit()).toBeUndefined();
});
