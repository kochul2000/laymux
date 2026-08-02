import { create } from "zustand";

/**
 * What the OS sleep inhibitor is actually doing, as last reported by the
 * backend (ADR-0113).
 *
 * Separate from `settings.power.sleepPrevention`, which is what the user asked
 * for. The two differ whenever a request fails — no `systemd-inhibit`, an
 * unsupported platform — and the top-bar toggle has to show the difference
 * rather than claim the machine is being kept awake when it is not.
 */
interface SleepInhibitState {
  /** Backend-confirmed: an inhibitor is held right now. */
  active: boolean;
  /** The last request did not go through; `active` is the state before it. */
  failed: boolean;
  reportSuccess: (active: boolean) => void;
  reportFailure: () => void;
}

export const useSleepInhibitStore = create<SleepInhibitState>((set) => ({
  active: false,
  failed: false,
  reportSuccess: (active) => set({ active, failed: false }),
  // The requested state is unknown after a failure, so the last confirmed
  // `active` stands and the flag says not to trust it.
  reportFailure: () => set({ failed: true }),
}));
