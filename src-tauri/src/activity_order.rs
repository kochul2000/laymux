//! Ordering for the two producers of pane activity (ADR-0135).
//!
//! Activity reaches the frontend from two places that never share a lock: the
//! PTY callback resolves each OSC 0/2 title on its own thread, and the reconcile
//! worker re-derives every pane on a timer. Both then apply their verdict to the
//! same store entry.
//!
//! Emission order is not derivation order. A reconcile pass takes its snapshot,
//! then walks every terminal before it emits; a title that arrives in that
//! window is derived later but delivered first, and the reconcile event — built
//! from state the title has already superseded — lands on top of it. The pane
//! then shows the older verdict until the next pass.
//!
//! So each producer stamps the activity with a sequence taken at the moment it
//! **derives** the value, not the moment it emits, and the frontend keeps the
//! highest stamp it has applied per pane and ignores anything older. The stamp
//! orders only the activity: a title event whose activity is rejected still
//! carries a title, a message, and an output-activity signal, all of which stay
//! valid.
//!
//! Nothing here bounds staleness — it only stops a stale value from winning.
//! Correcting one is the reconcile worker's job, and it runs again in
//! `ACTIVITY_RECONCILE_INTERVAL`.

use std::sync::atomic::{AtomicU64, Ordering};

/// Process-global, so a stamp from either producer is comparable with a stamp
/// from the other. Starts at 1 so that 0 can mean "never applied" on the
/// frontend side.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Take the next activity stamp. Call it immediately before deriving activity —
/// a stamp taken at emit time would claim an order the value does not have.
pub fn next_activity_sequence() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend compares stamps with `>`, so equal stamps from two
    /// producers would let either win by arrival order — the exact thing this
    /// module exists to remove.
    #[test]
    fn every_stamp_is_distinct_and_increasing() {
        let first = next_activity_sequence();
        let second = next_activity_sequence();
        assert!(second > first);
    }

    #[test]
    fn stamps_are_never_zero_so_zero_can_mean_never_applied() {
        assert!(next_activity_sequence() > 0);
    }

    /// Concurrent producers are the whole point: two threads deriving activity
    /// at once must not be handed the same stamp.
    #[test]
    fn concurrent_producers_never_share_a_stamp() {
        let handles: Vec<_> = (0..4)
            .map(|_| std::thread::spawn(|| (0..250).map(|_| next_activity_sequence()).collect()))
            .collect();
        let stamps: Vec<u64> = handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_else(|_| Vec::<u64>::new()))
            .collect();
        let unique: std::collections::HashSet<u64> = stamps.iter().copied().collect();
        assert_eq!(unique.len(), stamps.len());
    }
}
