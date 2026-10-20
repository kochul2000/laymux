//! Opaque, memory-only GUI display context. Never log its payload (ADR-0329).
use std::collections::{BTreeMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::control::connect_authenticated;
use super::wire::{read_frame, write_control, ClientMessage, DaemonMessage, Frame};
use super::DaemonEndpoint;
use crate::lock_ext::MutexExt;

pub const METADATA_KEY: &str = crate::constants::PTY_DAEMON_METADATA_DISPLAY_CONTEXT;
pub const MAX_CONTEXT_BYTES: usize = 64 * 1024;
// Even a string of control characters expands at most sixfold in JSON.
// Two 64 KiB contexts plus frame metadata stay below the 1 MiB wire limit.
pub(super) const READ_BATCH_SIZE: usize = 2;

fn context_connection(
    endpoint: &DaemonEndpoint,
) -> io::Result<(
    super::transport::Stream,
    std::io::BufReader<super::transport::Stream>,
)> {
    let (writer, reader) = connect_authenticated(endpoint)?;
    let timeout = Some(Duration::from_millis(
        crate::constants::PTY_DAEMON_HANDSHAKE_TIMEOUT_MS,
    ));
    writer.set_write_timeout(timeout)?;
    reader.get_ref().set_read_timeout(timeout)?;
    Ok((writer, reader))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DisplayContext(pub String);

impl std::fmt::Debug for DisplayContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DisplayContext(<redacted>)")
    }
}

#[derive(Clone)]
pub struct DisplayContextOwner {
    pub(super) endpoint: DaemonEndpoint,
    pub(super) session_id: String,
    pub(super) epoch: Arc<Mutex<Option<u64>>>,
    pub(super) unsupported: Arc<AtomicBool>,
}

impl std::fmt::Debug for DisplayContextOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DisplayContextOwner")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl DisplayContextOwner {
    pub fn save(&self, context: DisplayContext) -> Result<bool, String> {
        if context.0.len() > MAX_CONTEXT_BYTES {
            return Err("terminal display context exceeds its size limit".into());
        }
        if self.unsupported.load(Ordering::Acquire) {
            return Ok(false);
        }
        let epoch = self
            .epoch
            .lock_or_err()?
            .ok_or("PTY daemon is not attached")?;
        let result = update_context(&self.endpoint, &self.session_id, epoch, context);
        match result {
            Ok(accepted) => Ok(accepted),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof | io::ErrorKind::InvalidData
                ) =>
            {
                // An older daemon rejects this extension on the independent
                // control connection. Its terminal connection is untouched.
                self.unsupported.store(true, Ordering::Release);
                Ok(false)
            }
            Err(error) => Err(format!(
                "PTY daemon display context transfer failed: {}",
                error.kind()
            )),
        }
    }
}

pub(super) fn update_context(
    endpoint: &DaemonEndpoint,
    session_id: &str,
    attach_epoch: u64,
    context: DisplayContext,
) -> io::Result<bool> {
    let (mut writer, mut reader) = context_connection(endpoint)?;
    write_control(
        &mut writer,
        &ClientMessage::UpdateDisplayContext {
            session_id: session_id.to_owned(),
            attach_epoch,
            context,
        },
    )?;
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::DisplayContextStored { accepted })) => Ok(accepted),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported display context reply",
        )),
    }
}

/// Read only the layout's matching live sessions, without mounting inactive
/// workspaces or adding private input to the general daemon inventory.
pub fn load_contexts(
    profiles: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, DisplayContext>, String> {
    let root = super::DaemonRoot::for_current_build()?;
    let current = root.current().ok().map(|p| p.generation());
    let mut live = super::launcher::live_generations(&root, |_| true)?;
    live.sort_by_key(|g| {
        (
            std::cmp::Reverse(current.as_ref() == Some(&g.generation)),
            std::cmp::Reverse(g.started),
        )
    });
    let mut result = BTreeMap::new();
    let mut selected = HashSet::new();
    for generation in live {
        let is_current = current.as_ref() == Some(&generation.generation);
        let super::launcher::GenerationState::Ready(endpoint) = generation.state else {
            if is_current {
                return Ok(result);
            }
            continue;
        };
        let Ok(sessions) = super::list_sessions(&endpoint) else {
            if is_current {
                return Ok(result);
            }
            continue;
        };
        let sessions = select_sessions(sessions, profiles, &mut selected);
        for batch in sessions.chunks(READ_BATCH_SIZE) {
            let Ok((mut writer, mut reader)) = context_connection(&endpoint) else {
                break;
            };
            if write_control(
                &mut writer,
                &ClientMessage::ReadDisplayContexts {
                    session_ids: batch.iter().map(|s| s.session_id.clone()).collect(),
                },
            )
            .is_err()
            {
                break;
            }
            let Ok(Some(Frame::Control(DaemonMessage::DisplayContexts { contexts }))) =
                read_frame(&mut reader)
            else {
                break;
            };
            for session in batch {
                if let Some(context) = contexts.get(&session.session_id) {
                    result
                        .entry(session.terminal_id.clone())
                        .or_insert_with(|| context.clone());
                }
            }
        }
    }
    Ok(result)
}

fn select_sessions(
    mut sessions: Vec<super::SessionInfo>,
    profiles: &BTreeMap<String, String>,
    selected: &mut HashSet<String>,
) -> Vec<super::SessionInfo> {
    sessions.sort_by_key(|s| std::cmp::Reverse(s.created_seq));
    sessions
        .into_iter()
        .filter(|s| {
            !s.exited && !s.terminating && !s.attached && profiles.contains_key(&s.terminal_id)
        })
        .filter(|s| {
            // Claim the actual adoption candidate even if it has no context or
            // a different profile. An older child's text must not leak through.
            selected.insert(s.terminal_id.clone())
                && profiles.get(&s.terminal_id)
                    == s.metadata
                        .get(crate::constants::PTY_DAEMON_METADATA_PROFILE)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(id: &str, sequence: u64, profile: &str) -> super::super::SessionInfo {
        super::super::SessionInfo {
            session_id: id.into(),
            terminal_id: "t".into(),
            created_seq: sequence,
            attach_epoch: 1,
            metadata: BTreeMap::from([(
                crate::constants::PTY_DAEMON_METADATA_PROFILE.into(),
                profile.into(),
            )]),
            child_pid: Some(10),
            attached: false,
            exited: false,
            terminating: false,
        }
    }
    #[test]
    fn missing_context_does_not_fall_back_to_an_older_child() {
        let profiles = BTreeMap::from([("t".into(), "PS".into())]);
        let mut selected = HashSet::new();
        let current = select_sessions(
            vec![session("old", 1, "PS"), session("new", 2, "PS")],
            &profiles,
            &mut selected,
        );
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].session_id, "new");
        assert!(select_sessions(
            vec![session("earlier generation", 5, "PS")],
            &profiles,
            &mut selected
        )
        .is_empty());
    }
    #[test]
    fn wrong_profile_does_not_select_an_older_matching_child() {
        let profiles = BTreeMap::from([("t".into(), "PS".into())]);
        let mut selected = HashSet::new();
        assert!(
            select_sessions(vec![session("new", 2, "WSL")], &profiles, &mut selected).is_empty()
        );
        assert!(
            select_sessions(vec![session("old", 1, "PS")], &profiles, &mut selected).is_empty()
        );
    }
}
