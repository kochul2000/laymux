import { describe, it, expect, beforeEach, vi } from "vitest";

const setSleepInhibit = vi.fn<(enabled: boolean) => Promise<boolean>>();

vi.mock("@/lib/tauri-api", () => ({
  setSleepInhibit: (enabled: boolean) => setSleepInhibit(enabled),
}));

import {
  observeSleepInhibitState,
  releaseSleepInhibit,
  requestSleepInhibit,
  resetSleepInhibitCoordinator,
} from "./sleep-inhibit-coordinator";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";

/** Let the queue settle: each request only goes out after the previous one. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sent = () => setSleepInhibit.mock.calls.map(([enabled]) => enabled);

describe("sleep inhibit coordinator", () => {
  beforeEach(() => {
    setSleepInhibit.mockReset();
    // The real command answers with the state actually in effect.
    setSleepInhibit.mockImplementation((enabled) => Promise.resolve(enabled));
    resetSleepInhibitCoordinator();
    useSleepInhibitStore.setState(useSleepInhibitStore.getInitialState());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("sends the first request and dedupes what the backend confirmed", async () => {
    requestSleepInhibit(true);
    await flush();
    requestSleepInhibit(true);
    await flush();
    expect(sent()).toEqual([true]);
    expect(useSleepInhibitStore.getState()).toMatchObject({ active: true, failed: false });
  });

  it("keeps one request in flight and collapses what came and went", async () => {
    const first = deferred<boolean>();
    setSleepInhibit.mockReturnValueOnce(first.promise);

    requestSleepInhibit(true);
    requestSleepInhibit(false);
    requestSleepInhibit(true);
    expect(sent()).toEqual([true]);

    first.resolve(true);
    await flush();
    // Ended where the in-flight call already put it: nothing more to send.
    expect(sent()).toEqual([true]);
  });

  it("does not spin on a value the backend refuses", async () => {
    setSleepInhibit.mockRejectedValue(new Error("no systemd-inhibit"));

    requestSleepInhibit(true);
    await flush();
    await flush();
    expect(sent()).toEqual([true]);
    expect(useSleepInhibitStore.getState().failed).toBe(true);
  });

  it("does not spin when the same value is re-requested while a call is failing", async () => {
    // `whenBusy` re-derives the same `true` on every output event. Counting each
    // repeat as a new intent made the eventual rejection look superseded, so
    // nothing was held back and the queue re-sent the same doomed request — one
    // `systemd-inhibit` spawn and one warning per output event.
    const enable = deferred<boolean>();
    setSleepInhibit.mockReturnValueOnce(enable.promise);
    setSleepInhibit.mockRejectedValue(new Error("no systemd-inhibit"));

    requestSleepInhibit(true);
    for (let i = 0; i < 5; i += 1) requestSleepInhibit(true);
    expect(sent()).toEqual([true]);

    enable.reject(new Error("no systemd-inhibit"));
    for (let i = 0; i < 10; i += 1) await flush();

    expect(sent()).toEqual([true]);
    expect(useSleepInhibitStore.getState().failed).toBe(true);
  });

  it("stops holding a refused value back once something else is wanted", async () => {
    // The hold-back is per-value. Leaving it set after the answer moved on
    // would block that value for the rest of the session.
    setSleepInhibit.mockRejectedValueOnce(new Error("busy"));
    requestSleepInhibit(true);
    await flush();
    expect(sent()).toEqual([true]);

    // `false` was never confirmed either (the failure cleared what we knew),
    // so this goes out and re-opens `true`.
    requestSleepInhibit(false);
    await flush();
    requestSleepInhibit(true);
    await flush();
    expect(sent()).toEqual([true, false, true]);
  });

  it("treats an answer that differs from the request as refused, not confirmed", async () => {
    setSleepInhibit.mockResolvedValueOnce(false); // asked for true, got false

    requestSleepInhibit(true);
    await flush();
    await flush();
    expect(sent()).toEqual([true]);
    expect(useSleepInhibitStore.getState()).toMatchObject({ active: false, failed: true });
  });

  it("releases even when the in-flight request that preceded it failed", async () => {
    // The release is queued behind a disable that then rejects. Treating that
    // rejection as "already off" would leave the machine awake for good.
    const disable = deferred<boolean>();
    requestSleepInhibit(true);
    await flush();
    setSleepInhibit.mockReturnValueOnce(disable.promise);
    requestSleepInhibit(false);
    expect(sent()).toEqual([true, false]);

    releaseSleepInhibit();
    disable.reject(new Error("busy"));
    await flush();

    expect(sent()).toEqual([true, false, false]);
  });

  it("does not send a release when the backend already confirmed it is off", async () => {
    requestSleepInhibit(false);
    await flush();
    setSleepInhibit.mockClear();

    releaseSleepInhibit();
    await flush();
    expect(setSleepInhibit).not.toHaveBeenCalled();
  });

  it("gives up releasing after a bounded number of attempts", async () => {
    requestSleepInhibit(true);
    await flush();
    setSleepInhibit.mockClear();
    setSleepInhibit.mockRejectedValue(new Error("stuck"));

    releaseSleepInhibit();
    for (let i = 0; i < 10; i += 1) await flush();

    // Bounded, not unbounded: a machine that cannot release must not spin.
    expect(setSleepInhibit).toHaveBeenCalledTimes(3);
    expect(sent()).toEqual([false, false, false]);
  });

  it("shows a recovery the backend made on its own", async () => {
    // The watchdog re-acquired after a failure. No request carries that news,
    // so without the observation the button stays red over a protected machine.
    setSleepInhibit.mockRejectedValueOnce(new Error("transient"));
    requestSleepInhibit(true);
    await flush();
    expect(useSleepInhibitStore.getState()).toMatchObject({ active: false, failed: true });

    observeSleepInhibitState(true, true);
    await flush();

    expect(useSleepInhibitStore.getState()).toMatchObject({ active: true, failed: false });
    // Already where it should be, so nothing more is sent.
    expect(sent()).toEqual([true]);
  });

  it("re-requests after the backend reports it lost the inhibitor", async () => {
    requestSleepInhibit(true);
    await flush();
    setSleepInhibit.mockClear();

    // The watchdog saw the child die and could not get it back.
    observeSleepInhibitState(false, false);
    await flush();

    expect(useSleepInhibitStore.getState().active).toBe(true);
    expect(sent()).toEqual([true]);
  });

  it("a remount is not blocked by the failure of the request it replaced", async () => {
    // enable in flight → unmount → remount asks for it again → the original
    // enable rejects. That rejection belongs to an intent nobody holds any
    // more; recording it as refused would silently disable `always` until the
    // user changed the mode.
    const enable = deferred<boolean>();
    setSleepInhibit.mockReturnValueOnce(enable.promise);
    requestSleepInhibit(true);
    expect(sent()).toEqual([true]);

    releaseSleepInhibit();
    requestSleepInhibit(true);

    enable.reject(new Error("transient"));
    await flush();

    expect(sent()).toEqual([true, true]);
    expect(useSleepInhibitStore.getState().active).toBe(true);
  });

  it("survives a caller going away and a new one arriving", async () => {
    // The remount case. One queue, so the release and the new request cannot
    // interleave and settle in the wrong order.
    const release = deferred<boolean>();
    requestSleepInhibit(true);
    await flush();
    setSleepInhibit.mockClear();
    setSleepInhibit.mockReturnValueOnce(release.promise);

    releaseSleepInhibit();
    requestSleepInhibit(true);
    expect(sent()).toEqual([false]);

    release.resolve(false);
    await flush();

    expect(sent()).toEqual([false, true]);
    expect(useSleepInhibitStore.getState().active).toBe(true);
  });
});
