import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  getCodexUsageSnapshot: vi.fn(),
}));

import { getCodexUsageSnapshot } from "@/lib/tauri-api";
import {
  readCodexSnapshot,
  resetCodexUsageSubscriptions,
  subscribeCodexUsage,
} from "./codex-usage-subscription";

const snapshot = (capturedAtMs: number) => ({
  status: { type: "ready" as const },
  limits: [],
  plan: "Plus",
  capturedAtMs,
});

describe("codex usage subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getCodexUsageSnapshot).mockResolvedValue(snapshot(1));
  });

  afterEach(() => {
    resetCodexUsageSubscriptions();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reads once for several consumers of the same account", async () => {
    // Each read spawns a `codex app-server`, so one poll must serve every
    // surface — and they must all see the same capture.
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeCodexUsage("", 600_000, first);
    const unsubSecond = subscribeCodexUsage("", 600_000, second);
    await vi.advanceTimersByTimeAsync(0);

    expect(getCodexUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(readCodexSnapshot("")).toEqual(snapshot(1));

    unsubFirst();
    unsubSecond();
  });

  it("polls separately per account", async () => {
    const unsubDefault = subscribeCodexUsage("", 600_000, vi.fn());
    const unsubAlt = subscribeCodexUsage("/alt", 600_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(getCodexUsageSnapshot).toHaveBeenCalledWith("");
    expect(getCodexUsageSnapshot).toHaveBeenCalledWith("/alt");
    unsubDefault();
    unsubAlt();
  });

  it("stops polling once the last consumer leaves and restarts for a new one", async () => {
    const unsubscribe = subscribeCodexUsage("", 600_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(getCodexUsageSnapshot).toHaveBeenCalledTimes(1);

    subscribeCodexUsage("", 600_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(getCodexUsageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("honours the shortest interval any live consumer asked for", async () => {
    const unsubSlow = subscribeCodexUsage("", 1_800_000, vi.fn());
    const unsubFast = subscribeCodexUsage("", 600_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getCodexUsageSnapshot).mockClear();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(getCodexUsageSnapshot).toHaveBeenCalledTimes(1);

    unsubSlow();
    unsubFast();
  });

  it("surfaces a read failure instead of keeping the previous numbers", async () => {
    subscribeCodexUsage("", 600_000, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(getCodexUsageSnapshot).mockRejectedValueOnce(new Error("codex gone"));

    await vi.advanceTimersByTimeAsync(600_000);

    const current = readCodexSnapshot("");
    expect(current.status.type).toBe("failed");
    expect(current.capturedAtMs).toBeNull();
  });
});
