import { create } from "zustand";

/**
 * What the OS sleep inhibitor is actually doing, as last reported by the
 * backend (ADR-0114, ADR-0115).
 *
 * Separate from `settings.power`, which is what the user asked for. The two
 * differ whenever a request does not take — no `systemd-inhibit`, an
 * unsupported platform, a backend that answers with a different state. The
 * top-bar button reads `failed` from here so a refused request is visible;
 * `active` exists for the coordinator, which needs to know what is actually
 * held to decide what to send next.
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
