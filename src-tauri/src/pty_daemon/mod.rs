//! Detached terminal service and its GUI adapters (ADR-0300–0302).
pub(crate) mod auth;
pub(crate) mod broker;
mod business_events;
pub(crate) mod client;
pub(crate) mod clock;
pub(crate) mod entry;
mod event_journal;
pub(crate) mod gateway;
pub(crate) mod launcher;
pub(crate) mod projection;
pub(crate) mod reader;
pub(crate) mod requests;
pub(crate) mod runtime;
pub(crate) mod service;
mod session_projection;
pub(crate) mod session_writer;
pub(crate) mod transport;
pub(crate) mod wire;
pub(crate) mod worker;

pub use entry::run_if_requested;
