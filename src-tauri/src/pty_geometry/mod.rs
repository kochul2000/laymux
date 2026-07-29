//! ADR-0085 exact PTY geometry cutover contract.

mod boundary;
mod coordinator;
mod types;

pub use coordinator::PtyGeometryCoordinator;
pub use types::*;

#[cfg(test)]
mod tests;
