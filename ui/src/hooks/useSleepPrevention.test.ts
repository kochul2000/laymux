import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const setSleepInhibit = vi.fn<(enabled: boolean) => Promise<boolean>>();

vi.mock("@/lib/tauri-api", () => ({
  setSleepInhibit: (enabled: boolean) => setSleepInhibit(enabled),
}));

import { useSleepPrevention } from "./useSleepPrevention";
import { resetSleepInhibitCoordinator } from "@/lib/sleep-inhibit-coordinator";
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Mount with the initial reconcile already settled and the spy cleared. */
async function mounted() {
  const rendered = renderHook(() => useSleepPrevention());
  await flush();
  setSleepInhibit.mockClear();
  return rendered;
}

const sent = () => setSleepInhibit.mock.calls.map(([enabled]) => enabled);

describe("useSleepPrevention", () => {
  beforeEach(() => {
    setSleepInhibit.mockReset();
    // The real command answers with the state actually in effect.
    setSleepInhibit.mockImplementation((enabled) => Promise.resolve(enabled));
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSleepInhibitStore.setState(useSleepInhibitStore.getInitialState());
    resetSleepInhibitCoordinator();
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

  it("releases on unmount, and a remount picks it back up in order", async () => {
    // The state machine lives outside the component, so the old mount's release
    // and the new mount's request share one queue instead of racing.
    useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    const { unmount } = renderHook(() => useSleepPrevention());
    await flush();
    setSleepInhibit.mockClear();

    unmount();
    renderHook(() => useSleepPrevention());
    await flush();

    expect(sent()).toEqual([false, true]);
    expect(useSleepInhibitStore.getState().active).toBe(true);
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
