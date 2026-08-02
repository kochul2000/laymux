import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const setSleepInhibit = vi.fn<(enabled: boolean) => Promise<boolean>>();

vi.mock("@/lib/tauri-api", () => ({
  setSleepInhibit: (enabled: boolean) => setSleepInhibit(enabled),
}));

import { useSleepPrevention } from "./useSleepPrevention";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

function registerBusyTerminal(id: string) {
  const store = useTerminalStore.getState();
  store.registerInstance({ id, profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-1" });
  store.updateInstanceInfo(id, { outputActive: true });
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

describe("useSleepPrevention", () => {
  beforeEach(() => {
    setSleepInhibit.mockReset();
    setSleepInhibit.mockResolvedValue(true);
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("reconciles the backend on mount", () => {
    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    renderHook(() => useSleepPrevention());
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("stays off while the mode is off, however busy the terminals get", () => {
    renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();

    act(() => registerBusyTerminal("t1"));
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("inhibits as soon as the mode becomes always, with no terminals at all", () => {
    renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("in whenBusy, follows the terminals rather than the mode alone", () => {
    renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" }));
    expect(setSleepInhibit).not.toHaveBeenCalled();

    act(() => registerBusyTerminal("t1"));
    expect(setSleepInhibit).toHaveBeenLastCalledWith(true);

    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: false }));
    expect(setSleepInhibit).toHaveBeenLastCalledWith(false);
  });

  it("sends one call per change, not per activity update", () => {
    renderHook(() => useSleepPrevention());
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" }));
    act(() => registerBusyTerminal("t1"));
    setSleepInhibit.mockClear();

    // A second busy terminal does not change the answer.
    act(() => registerBusyTerminal("t2"));
    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: true }));
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("does not re-render its host when the busy state flips", () => {
    // The whole reason this subscribes instead of selecting: nothing renders
    // from the busy flag, so an agent toggling it every few seconds must not
    // reconcile the tree that mounted the hook.
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useSleepPrevention();
    });
    useSettingsStore.getState().setPower({ sleepPrevention: "whenBusy" });
    const baseline = renders;

    act(() => registerBusyTerminal("t1"));
    act(() => useTerminalStore.getState().updateInstanceInfo("t1", { outputActive: false }));

    expect(setSleepInhibit).toHaveBeenLastCalledWith(false);
    expect(renders).toBe(baseline);
  });

  it("retries on the next change after a failed call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();
    setSleepInhibit.mockRejectedValueOnce(new Error("no systemd-inhibit"));

    await act(async () => {
      useSettingsStore.getState().setPower({ sleepPrevention: "always" });
    });
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(true);

    // The mode is untouched by the failure — the user's choice is not rewritten.
    expect(useSettingsStore.getState().power.sleepPrevention).toBe("always");

    // A later change is attempted again instead of being skipped as a duplicate.
    await act(async () => {
      useSettingsStore.getState().setPower({ sleepPrevention: "off" });
    });
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
    renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();
    setSleepInhibit.mockReturnValueOnce(enable.promise);

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "off" }));
    expect(setSleepInhibit.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);

    await act(async () => {
      enable.reject(new Error("too late"));
      await Promise.resolve();
    });

    setSleepInhibit.mockClear();
    // "off" is still the last known state, so re-deriving it sends nothing.
    act(() => registerBusyTerminal("t1"));
    expect(setSleepInhibit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("releases the inhibitor on unmount", () => {
    const { unmount } = renderHook(() => useSleepPrevention());
    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    setSleepInhibit.mockClear();

    unmount();
    expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not release on unmount when nothing was being inhibited", () => {
    const { unmount } = renderHook(() => useSleepPrevention());
    setSleepInhibit.mockClear();

    unmount();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("stops following the stores after unmount", () => {
    const { unmount } = renderHook(() => useSleepPrevention());
    unmount();
    setSleepInhibit.mockClear();

    act(() => useSettingsStore.getState().setPower({ sleepPrevention: "always" }));
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });
});
