import { create } from "zustand";

/**
 * What the OS sleep inhibitor is actually doing, as last reported by the
 * backend (ADR-0114).
 *
 * Separate from `settings.power.sleepPrevention`, which is what the user asked
 * for. The two differ whenever a request does not take — no `systemd-inhibit`,
 * an unsupported platform, a backend that answers with a different state — and
 * the top-bar toggle has to show the difference rather than claim the machine
 * is being kept awake when it is not.
 */
interface SleepInhibitState {
  /** Backend-confirmed: an inhibitor is held right now. */
  active: boolean;
  /** The last request did not deliver what was asked for. */
  failed: boolean;
  /** A request completed: `active` is the state in effect, `satisfied` whether it is the one asked for. */
  reportResult: (active: boolean, satisfied: boolean) => void;
  /** A request threw: the state in effect is unknown, so the last one stands. */
  reportFailure: () => void;
}

export const useSleepInhibitStore = create<SleepInhibitState>((set) => ({
  active: false,
  failed: false,
  reportResult: (active, satisfied) => set({ active, failed: !satisfied }),
  reportFailure: () => set({ failed: true }),
}));
