import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshAgentHookUpdates,
  subscribeAgentHookUpdates,
  updateAgentHooks,
  useAgentHookUpdateStore,
} from "./agent-hook-updates";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
});

describe("agent hook update coordinator", () => {
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
  it("checks again after 60 seconds and stops checking after unmount", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ targets: [], errors: [] });
    const stop = subscribeAgentHookUpdates();
    await refreshAgentHookUpdates();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event("focus"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
