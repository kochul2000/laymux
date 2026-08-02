import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const setSleepInhibit = vi.fn<(enabled: boolean) => Promise<boolean>>();

vi.mock("@/lib/tauri-api", () => ({
  setSleepInhibit: (enabled: boolean) => setSleepInhibit(enabled),
}));

import { useSleepPrevention } from "./useSleepPrevention";
import { useSettingsStore } from "@/stores/settings-store";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";
import { useTerminalStore } from "@/stores/terminal-store";

function registerBusyTerminal(id: string) {
  const store = useTerminalStore.getState();
  store.registerInstance({ id, profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-1" });
  store.updateInstanceInfo(id, { outputActive: true });
}

/**
 * Let the request queue settle. Calls are serialized, so a change made while
 * one is in flight only goes out after that one resolves.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A deferred promise, so a call can be left in flight on purpose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mount with the initial reconcile already settled and the spy cleared. */
async function mounted() {
  const rendered = renderHook(() => useSleepPrevention());
  await flush();
  setSleepInhibit.mockClear();
  return rendered;
}

describe("useSleepPrevention", () => {
  beforeEach(() => {
    setSleepInhibit.mockReset();
    // The real command answers with the state actually in effect.
    setSleepInhibit.mockImplementation((enabled) => Promise.resolve(enabled));
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSleepInhibitStore.setState(useSleepInhibitStore.getInitialState());
  });

  it("reconciles the backend on mount", () => {
    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    renderHook(() => useSleepPrevention());
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("stays off while the mode is off, however busy the terminals get", async () => {
    await mounted();

    act(() => registerBusyTerminal("t1"));
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("inhibits as soon as the mode becomes always, with no terminals at all", async () => {
    await mounted();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("in whenBusy, follows the terminals rather than the mode alone", async () => {
    await mounted();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" }));
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();

    act(() => registerBusyTerminal("t1"));
    await flush();
    expect(setSleepInhibit).toHaveBeenLastCalledWith(true);

    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: false }));
    await flush();
    expect(setSleepInhibit).toHaveBeenLastCalledWith(false);
  });

  it("sends one call per change, not per activity update", async () => {
    await mounted();
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" }));
    act(() => registerBusyTerminal("t1"));
    await flush();
    setSleepInhibit.mockClear();

    // A second busy terminal does not change the answer.
    act(() => registerBusyTerminal("t2"));
    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: true }));
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("does not re-render its host when the busy state flips", async () => {
    // The whole reason this subscribes instead of selecting: nothing renders
    // from the busy flag, so an agent toggling it every few seconds must not
    // reconcile the tree that mounted the hook.
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useSleepPrevention();
    });
    useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" });
    await flush();
    const baseline = renders;

    act(() => registerBusyTerminal("t1"));
    await flush();
    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: false }));
    await flush();

    expect(setSleepInhibit).toHaveBeenLastCalledWith(false);
    expect(renders).toBe(baseline);
  });

  it("never has two requests in flight at once", async () => {
    // The Rust command is async, so overlapping calls could be applied in
    // either order and leave the OS in the state the earlier one asked for.
    const first = deferred<boolean>();
    await mounted();
    setSleepInhibit.mockReturnValueOnce(first.promise);

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);

    // Nothing else goes out while the first call is unresolved.
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    expect(setSleepInhibit).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await flush();
    expect(setSleepInhibit.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
  });

  it("collapses states that came and went while a call was in flight", async () => {
    // Only where the user ended up is worth a round trip.
    const first = deferred<boolean>();
    await mounted();
    setSleepInhibit.mockReturnValueOnce(first.promise);

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));

    first.resolve(true);
    await flush();
    // Back where the in-flight call already put it: no second call at all.
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not spin re-sending a value the backend just refused", async () => {
    // A machine that cannot inhibit sleep fails every time; an immediate retry
    // of the same value would loop as fast as promises resolve.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mounted();
    setSleepInhibit.mockRejectedValue(new Error("no systemd-inhibit"));

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();
    await flush();
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);
    warn.mockRestore();
  });

  it("attempts the next change after a failed call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mounted();
    setSleepInhibit.mockRejectedValueOnce(new Error("no systemd-inhibit"));

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);

    // The mode is untouched by the failure — the user's choice is not rewritten.
    expect(useSettingsStore.getState().power.sleepPrevention).toBe("always");

    // A later change is attempted again instead of being skipped as a duplicate.
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    await flush();
    expect(setSleepInhibit).toHaveBeenCalledTimes(2);
    expect(setSleepInhibit).toHaveBeenLastCalledWith(false);
    warn.mockRestore();
  });

  it("a failure does not undo a newer request that superseded it", async () => {
    // The enable is still in flight when the user turns the mode off. When the
    // enable finally rejects it must not forget that "off" was already sent, or
    // the next flip back to off would be dropped as a duplicate.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const enable = deferred<boolean>();
    await mounted();
    setSleepInhibit.mockReturnValueOnce(enable.promise);

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));

    enable.reject(new Error("too late"));
    await flush();
    expect(setSleepInhibit.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);

    setSleepInhibit.mockClear();
    // "off" is still the last known state, so re-deriving it sends nothing.
    act(() => registerBusyTerminal("t1"));
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still tries to release on unmount after a failed disable", async () => {
    // The disable failed, so the backend may well still be holding. Treating
    // the failed attempt as "already off" would strand the machine awake for
    // the rest of the OS session.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = await mounted();
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();

    setSleepInhibit.mockRejectedValueOnce(new Error("busy"));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    await flush();
    setSleepInhibit.mockClear();

    unmount();
    await flush();
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(false);
    warn.mockRestore();
  });

  it("publishes what the backend confirmed, and flags what it refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mounted();

    setSleepInhibit.mockResolvedValueOnce(true);
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();
    expect(useSleepInhibitStore.getState()).toMatchObject({ active: true, failed: false });

    setSleepInhibit.mockRejectedValueOnce(new Error("no systemd-inhibit"));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    await flush();
    // Still reported as held: the release failed, so nothing says it let go.
    expect(useSleepInhibitStore.getState()).toMatchObject({ active: true, failed: true });
    warn.mockRestore();
  });

  it("releases the inhibitor on unmount", async () => {
    const { unmount } = await mounted();
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();
    setSleepInhibit.mockClear();

    unmount();
    await flush();
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not release on unmount when nothing was being inhibited", async () => {
    const { unmount } = await mounted();

    unmount();
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("stops following the stores after unmount", async () => {
    const { unmount } = await mounted();
    unmount();
    await flush();
    setSleepInhibit.mockClear();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });
});
