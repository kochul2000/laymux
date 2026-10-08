//! Detached PTY daemon (ADR-0300).
//!
//! With [`ENV_LAYMUX_PTY_DAEMON`]` = 1`, terminal PTYs and their child
//! processes are owned by a separate `laymux --pty-daemon` process instead of
//! the GUI. The GUI talks to it through [`DaemonPtySystem`], a
//! `portable_pty::PtySystem` implementation, so the output pipeline above the
//! PTY is unchanged. A GUI that disappears without terminating its terminals
//! only detaches: the sessions keep running in the daemon and can be
//! re-attached. Re-adopting them in a new GUI and update handoff build on this
//! core in later steps.
//!
//! [`ENV_LAYMUX_PTY_DAEMON`]: crate::constants::ENV_LAYMUX_PTY_DAEMON

mod backend;
mod client;
mod client_queue;
mod discovery;
mod entry;
mod launcher;
mod server;
mod session;
mod transport;
mod wire;

#[cfg(test)]
mod tests;

pub use backend::{is_enabled, session_key, terminal_backend, DaemonEndpoint};
pub use client::{list_sessions, terminate_session, DaemonPtySystem};
pub use discovery::DaemonPaths;
pub use entry::run_daemon_main;
pub use launcher::{ensure_running, find_running, spawn_daemon};
pub use wire::SessionInfo;
