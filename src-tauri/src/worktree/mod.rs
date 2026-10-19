mod canonical;
mod git;
mod inspection;
mod legacy;
mod parsing;
mod service;
mod types;

pub use canonical::canonicalize_host_path;
pub use service::{inspect, remove, remove_with_guard, snapshot};
pub use types::{WorktreeEntry, WorktreeFile, WorktreeInspection, WorktreeSnapshot};

#[cfg(test)]
mod tests;
