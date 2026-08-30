mod android_pairing;
mod app_update;
mod archive_listing;
mod claude_session;
mod codex_session;
mod codex_usage;
mod file_ops;
mod file_viewer;
mod github_repo;
mod grok_session;
mod grok_usage;
mod ipc_dispatch;
mod misc;
mod os_open;
mod power;
mod remote_hosts;
mod session_attribution;
mod terminal;
mod terminal_output_delivery;
mod terminal_output_surface;
mod terminal_teardown;
mod usage;
mod viewer_startup;
mod wsl_agent_session;

pub use crate::cloud::commands::*;
pub use android_pairing::*;
pub use app_update::*;
pub use archive_listing::*;
pub use claude_session::*;
pub use codex_session::*;
pub use codex_usage::*;
pub use file_ops::*;
pub use file_viewer::*;
pub use github_repo::*;
pub use grok_session::*;
pub use grok_usage::*;
pub use ipc_dispatch::*;
pub use misc::*;
pub use os_open::*;
pub use power::*;
pub use remote_hosts::*;
pub use session_attribution::*;
pub use terminal::*;
pub use terminal_output_surface::*;
pub use usage::*;
pub use viewer_startup::*;

/// Commands whose body reaches the filesystem, spawns a process or enumerates
/// a system resource must not run on the main thread (ADR-0202).
///
/// The choice is invisible at runtime — a main-thread stall looks like a laggy
/// window, not a failing test — so the attribute itself is the contract, and
/// this table is what keeps a later edit from silently dropping one back onto
/// the event loop.
#[cfg(test)]
mod main_thread_io {
    /// `(file source, commands that must carry `#[tauri::command(async)]`)`.
    const OFF_MAIN_THREAD: &[(&str, &[&str])] = &[
        (
            include_str!("file_ops.rs"),
            &[
                "stat_path",
                "stat_paths",
                "get_home_directory",
                "list_directory",
                "open_settings_file",
            ],
        ),
        (
            include_str!("file_viewer.rs"),
            &["read_file_for_viewer", "read_file_for_download"],
        ),
        (
            include_str!("misc.rs"),
            &[
                "list_system_monospace_fonts",
                "load_settings",
                "load_settings_validated",
                "reset_settings",
                "save_settings",
                "load_memo",
                "save_memo",
                "get_listening_ports",
                "get_git_branch",
                "resolve_git_remote",
                "send_os_notification",
                "save_terminal_output_cache",
                "load_terminal_output_cache",
                "clean_terminal_output_cache",
                "save_window_geometry",
                "load_window_geometry",
            ],
        ),
        (
            include_str!("claude_session.rs"),
            &["get_claude_session_ids"],
        ),
        (include_str!("codex_session.rs"), &["get_codex_session_ids"]),
        (include_str!("grok_session.rs"), &["get_grok_session_ids"]),
        (
            include_str!("codex_usage.rs"),
            &["get_codex_usage_snapshot"],
        ),
        (
            include_str!("grok_usage.rs"),
            &["subscribe_grok_usage_probe", "refresh_grok_usage_probe"],
        ),
        (include_str!("usage.rs"), &["subscribe_usage_probe"]),
        (include_str!("os_open.rs"), &["open_in_os"]),
    ];

    #[test]
    fn io_commands_stay_off_the_main_thread() {
        for (source, commands) in OFF_MAIN_THREAD {
            for command in *commands {
                let blocking = format!("#[tauri::command]\npub fn {command}(");
                let threadpool = format!("#[tauri::command(async)]\npub fn {command}(");
                assert!(
                    !source.contains(&blocking),
                    "`{command}` must stay `#[tauri::command(async)]`: a plain command runs its \
                     filesystem/process work inline on the app's main thread and stalls the window"
                );
                assert!(
                    source.contains(&threadpool),
                    "`{command}` no longer matches the `#[tauri::command(async)]\npub fn` shape \
                     this contract is checked against — update the table with it"
                );
            }
        }
    }
}
