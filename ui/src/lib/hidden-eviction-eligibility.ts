/**
 * Window-local handoff between the hidden-terminal timer and the native
 * checkpoint listener. Only the currently mounted timer effect may publish
 * eligibility; a retired StrictMode effect cannot clear its successor's set.
 */

let nextOwner = 0;
let currentOwner = 0;
let eligiblePaneIds = new Set<string>();

export interface HiddenEvictionEligibilityLease {
  publish(paneIds: ReadonlySet<string>): void;
  release(): void;
}

export function claimHiddenEvictionEligibility(): HiddenEvictionEligibilityLease {
  const owner = ++nextOwner;
  currentOwner = owner;
  eligiblePaneIds = new Set();

  return {
    publish(paneIds) {
      if (currentOwner === owner) eligiblePaneIds = new Set(paneIds);
    },
    release() {
      if (currentOwner !== owner) return;
      currentOwner = 0;
      eligiblePaneIds = new Set();
    },
  };
}

export function areHiddenPaneIdsEligible(paneIds: readonly string[]): boolean {
  return paneIds.length > 0 && paneIds.every((paneId) => eligiblePaneIds.has(paneId));
}
