import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshAgentHookUpdates,
  subscribeAgentHookUpdates,
  updateAgentHooks,
  useAgentHookUpdateStore,
} from "./agent-hook-updates";
const invoke = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => ({
  handler: undefined as (() => void) | undefined,
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event, handler) => {
    events.handler = handler;
    return events.stop;
  }),
}));
const target = {
  provider: "codex" as const,
  distro: "Ubuntu",
  status: {
    configDir: "/custom",
    configPath: "/custom/hooks.json",
    installed: true,
    registered: 10,
    expected: 10,
    helperPresent: true,
    disabled: false,
    updateRequired: true,
  },
};
afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
  events.handler = undefined;
  events.stop.mockReset();
});

describe("agent hook update coordinator", () => {
  it("does not lose discovery while an unrelated manual inspection is in flight", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const manual = refreshAgentHookUpdates();
    const discovered = refreshAgentHookUpdates(true);
    resolve({ targets: [], errors: [] });
    await manual;
    await discovered;
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      { automatic: false },
      { automatic: true },
    ]);
  });
  it("queues a manual reinspection after an in-flight automatic check", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const automatic = refreshAgentHookUpdates(true);
    const manual = refreshAgentHookUpdates();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ targets: [], errors: [] });
    await automatic;
    await manual;
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      { automatic: true },
      { automatic: false },
    ]);
  });
  it("coalesces discovery during a slow startup into one follow-up cached check", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i++) events.handler?.();
      expect(invoke).toHaveBeenCalledTimes(1);
      resolve({ targets: [], errors: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
  it("keeps a known stale target when only that environment fails in a partial audit", async () => {
    useAgentHookUpdateStore.setState({ targets: [target] });
    invoke.mockResolvedValue({
      targets: [],
      errors: [{ provider: "codex", distro: "Ubuntu", configDir: null, message: "timeout" }],
    });
    await refreshAgentHookUpdates();
    expect(useAgentHookUpdateStore.getState().targets).toEqual([target]);
  });

  it("retains the successful update result if the following audit fails", async () => {
    useAgentHookUpdateStore.setState({ targets: [target] });
    invoke.mockResolvedValueOnce({ ...target.status, updateRequired: false, helperCurrent: true });
    invoke.mockRejectedValueOnce(new Error("audit timed out"));
    await updateAgentHooks(target);
    expect(useAgentHookUpdateStore.getState().targets[0].status.updateRequired).toBe(false);
  });
  it("shares an in-flight read across startup, focus and manual checks", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = refreshAgentHookUpdates();
    const second = refreshAgentHookUpdates();
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ targets: [target], errors: [] });
    await first;
  });
  it("finishes an older audit before updating, then reads the repaired state", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    invoke.mockResolvedValueOnce({ ...target.status, updateRequired: false });
    invoke.mockResolvedValueOnce({ targets: [], errors: [] });
    const check = refreshAgentHookUpdates();
    const update = updateAgentHooks(target);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ targets: [target], errors: [] });
    await check;
    await update;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_agent_hook_updates",
      "manage_agent_hooks",
      "get_agent_hook_updates",
    ]);
    expect(useAgentHookUpdateStore.getState().targets).toEqual([]);
  });
  it("keeps known stale hooks when a subsequent audit fails", async () => {
    useAgentHookUpdateStore.setState({ targets: [target] });
    invoke.mockRejectedValue(new Error("WSL timeout"));
    await refreshAgentHookUpdates();
    expect(useAgentHookUpdateStore.getState().targets).toEqual([target]);
    expect(useAgentHookUpdateStore.getState().errors[0].message).toContain("WSL timeout");
  });
  it("does not inspect again on elapsed time or focus and unsubscribes on unmount", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event("focus"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(events.stop).toHaveBeenCalled();
  });
  it("does not repeat automatic checks when focus returns during the 60-second interval", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
  it("does not schedule another inspection after a slow automatic check", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      window.dispatchEvent(new Event("focus"));
      resolve({ targets: [], errors: [] });
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
  it("keeps explicit refresh available during the automatic check interval", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await refreshAgentHookUpdates();
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
  it("checks only uninspected targets when a new target is announced", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    try {
      await vi.advanceTimersByTimeAsync(0);
      events.handler?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke.mock.calls).toEqual([
        ["get_agent_hook_updates", { automatic: true }],
        ["get_agent_hook_updates", { automatic: true }],
      ]);
      await refreshAgentHookUpdates();
      expect(invoke).toHaveBeenLastCalledWith("get_agent_hook_updates", { automatic: false });
    } finally {
      stop();
    }
  });
});
