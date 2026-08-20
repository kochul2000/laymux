#![recursion_limit = "256"]
pub mod activity;
pub mod activity_order;
pub mod activity_reconcile;
pub mod android_e2e;
pub mod android_pairing;
pub mod app_update;
pub mod automation_server;
#[cfg(test)]
mod build_metadata;
pub mod claude_activity;
pub mod claude_bullet;
pub mod cli;
pub mod clipboard;
pub mod cloud;
pub mod codex_activity;
pub mod commands;
#[cfg(test)]
mod conpty_build;
pub mod conpty_runtime;
pub mod constants;
pub mod crash_reporter;
pub mod error;
pub mod frontend_health;
pub mod git_watcher;
pub mod grok_activity;
pub mod grok_usage_probe;
pub mod ipc_server;
pub mod lock_ext;
pub mod osc;
pub mod osc_hooks;
pub mod output_buffer;
pub mod path_utils;
pub mod port_detect;
pub mod power;
pub mod process;
pub mod process_tree;
pub mod pty;
mod pty_control;
pub mod pty_geometry;
mod pty_reader;
pub mod pty_trace;
pub mod remote_server;
pub mod remote_session;
pub mod settings;
pub mod state;
pub mod terminal;
mod terminal_env;
pub mod terminal_output;
pub mod terminal_protocol;
pub mod usage_probe;
pub mod wsl_liveness;
pub mod wsl_probe;

use std::sync::Arc;
use tauri::image::Image;
use tauri::{Emitter, Manager};

use crate::lock_ext::MutexExt;

pub fn run() {
    // 가장 먼저 패닉 훅을 설치한다. 이후 초기화 중 패닉이 나도
    // `last-crash.json` / `crash.log`로 캡처되어 다음 실행 때 다이얼로그로 표시된다.
    crash_reporter::install(settings::dirs_config_path());

    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_state = Arc::new(state::AppState::new());

            // Start IPC server for IDE CLI communication
            let session_id = format!("{}", std::process::id());
            let state_for_ipc = app_state.clone();
            let app_handle_for_ipc = app.handle().clone();
            match ipc_server::start_ipc_server(
                session_id,
                Arc::new(move |msg| {
                    let message_json = match serde_json::to_string(&msg) {
                        Ok(json) => json,
                        Err(e) => return cli::LxResponse::err(format!("Serialize error: {e}")),
                    };
                    // Route through the same handler as the Tauri command
                    match commands::handle_lx_message_inner(
                        &message_json,
                        &state_for_ipc,
                        &app_handle_for_ipc,
                    ) {
                        Ok(resp) => resp,
                        Err(e) => cli::LxResponse::err(e),
                    }
                }),
            ) {
                Ok(socket_path) => match app_state.ipc_socket_path.lock_or_err() {
                    Ok(mut path) => {
                        path.replace(socket_path);
                    }
                    Err(error) => {
                        tracing::warn!(%error, "failed to store IPC socket path");
                    }
                },
                Err(e) => {
                    tracing::warn!(error = %e, "IPC server failed to start");
                }
            }

            // Clean up old paste images (older than 7 days)
            {
                let paste_dir = clipboard::default_paste_image_dir();
                if let Err(e) = clipboard::cleanup_old_paste_images(&paste_dir, 7) {
                    tracing::warn!(error = %e, "Paste image cleanup failed");
                }
            }

            // Remote image/text uploads are app-owned cache files. Keep the same
            // bounded retention window as desktop smart-paste images (ADR-0181).
            match remote_server::cleanup_stale_attachments(
                constants::REMOTE_TERMINAL_ATTACHMENT_MAX_AGE_DAYS,
            ) {
                Ok(removed) if removed > 0 => {
                    tracing::info!(removed, "Pruned stale Remote terminal attachments");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, "Remote terminal attachment cleanup failed");
                }
            }

            // Clean up old MCP show_image temp files (older than 7 days)
            {
                let removed = automation_server::mcp::cleanup_mcp_image_cache(7);
                if removed > 0 {
                    tracing::info!(removed, "Pruned stale MCP show_image temp files");
                }
            }

            // Start automation HTTP server
            let app_handle = app.handle().clone();
            let auto_state = app_state.clone();
            tauri::async_runtime::spawn(async move {
                match automation_server::start(auto_state, app_handle).await {
                    Ok(port) => tracing::info!(port, "Automation API ready"),
                    Err(e) => tracing::warn!(error = %e, "Automation server failed to start"),
                }
            });

            // Re-derive every terminal's activity on a timer and push the panes
            // that changed, so a classification the event path missed — an
            // interactive app parked at its prompt emits no further titles — does
            // not stay wrong until the user types (ADR-0135). This worker also
            // owns the WSL guest probe (ADR-0134).
            activity_reconcile::start(app_state.clone(), app.handle().clone());

            let cloud_state = app_state.clone();
            let cloud_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match cloud::tunnel::start_auto_reconnect(cloud_state, cloud_app).await {
                    Ok(Some(_)) => tracing::info!("Cloud tunnel auto-reconnect started"),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(error = %e, "Cloud tunnel auto-reconnect failed"),
                }
            });

            // Watch for OS remote-desktop (RDP) session transitions and push
            // them to the UI so it can auto-open the Remote Access panel when
            // the window is entered from a phone. Windows-only; other platforms
            // have no equivalent session concept.
            #[cfg(target_os = "windows")]
            {
                let rdp_app = app.handle().clone();
                std::thread::spawn(move || {
                    remote_session::watch_remote_session(rdp_app);
                });
            }

            // Push usage snapshots to the UI so `UsageView` learns about a fresh
            // capture without polling (ADR-0102).
            {
                let usage_app = app.handle().clone();
                if let Err(error) = app_state.usage_probe.set_sink(Arc::new(
                    move |snapshot: &usage_probe::UsageSnapshot| {
                        if let Err(error) =
                            usage_app.emit(constants::EVENT_USAGE_SNAPSHOT_CHANGED, snapshot)
                        {
                            tracing::warn!(%error, "failed to emit usage snapshot");
                        }
                    },
                )) {
                    tracing::warn!(%error, "failed to install usage snapshot sink");
                }
            }

            {
                let grok_app = app.handle().clone();
                if let Err(error) = app_state.grok_usage_probe.set_sink(Arc::new(
                    move |snapshot: &grok_usage_probe::GrokUsageSnapshot| {
                        if let Err(error) =
                            grok_app.emit(constants::EVENT_GROK_USAGE_SNAPSHOT_CHANGED, snapshot)
                        {
                            tracing::warn!(%error, "failed to emit grok usage snapshot");
                        }
                    },
                )) {
                    tracing::warn!(%error, "failed to install grok usage snapshot sink");
                }
            }

            // Set window icon (for taskbar in dev mode)
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }

            // Watch for a sleep inhibitor that dies behind our back, or one that
            // was never acquired because the first attempt failed (ADR-0114).
            // Started here rather than on first use; `set_sleep_inhibit` retries
            // it, so a spawn failure now is not permanent.
            {
                let power_app = app.handle().clone();
                if let Err(error) = app_state.sleep_inhibitor.set_sink(Arc::new(
                    move |held: bool, satisfied: bool| {
                        if let Err(error) = power_app.emit(
                            constants::EVENT_SLEEP_INHIBIT_CHANGED,
                            serde_json::json!({ "active": held, "satisfied": satisfied }),
                        ) {
                            tracing::warn!(%error, "failed to emit sleep inhibitor state");
                        }
                    },
                )) {
                    tracing::warn!(%error, "failed to install the sleep inhibitor sink");
                }
            }
            if !app_state.sleep_inhibitor.ensure_watchdog() {
                tracing::warn!("sleep inhibitor watchdog unavailable; will retry on next request");
            }

            app_update::start_periodic_checks(app.handle().clone(), app_state.app_update.clone());

            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::create_terminal_session,
            commands::get_terminal_geometry_capabilities,
            commands::resize_terminal,
            commands::write_to_terminal,
            commands::write_terminal_protocol_reply,
            commands::write_terminal_bootstrap_protocol_reply,
            commands::interrupt_terminal_on_exit,
            commands::write_terminal_input,
            commands::attach_terminal_output,
            commands::acknowledge_terminal_output,
            commands::acknowledge_terminal_output_envelope,
            commands::repair_terminal_output_envelope,
            commands::fail_stop_terminal_output_surface,
            commands::hold_terminal_output_continuation,
            commands::close_terminal_output_continuation,
            commands::resume_terminal_output,
            commands::log_terminal_trace_batch,
            commands::close_terminal_session,
            commands::mark_claude_terminal,
            commands::mark_codex_terminal,
            commands::mark_grok_terminal,
            commands::is_claude_terminal,
            commands::is_codex_terminal,
            commands::is_grok_terminal,
            commands::get_claude_session_ids,
            commands::get_codex_session_ids,
            commands::get_grok_session_ids,
            commands::get_sync_group_terminals,
            commands::handle_lx_message,
            commands::list_system_monospace_fonts,
            commands::load_settings,
            commands::save_settings,
            commands::load_memo,
            commands::save_memo,
            commands::open_settings_file,
            commands::open_in_os,
            commands::submit_github_issue,
            commands::get_github_repo_snapshot,
            commands::run_github_item_action,
            commands::get_listening_ports,
            commands::get_git_branch,
            commands::resolve_git_remote,
            commands::send_os_notification,
            commands::automation_response,
            commands::report_frontend_health,
            commands::get_terminal_states,
            commands::get_terminal_cwds,
            commands::get_terminal_summaries,
            commands::mark_notifications_read,
            commands::smart_paste,
            commands::clipboard_write_text,
            commands::set_terminal_cwd_send,
            commands::set_terminal_cwd_receive,
            commands::propagate_cwd_once,
            commands::update_terminal_sync_group,
            commands::save_terminal_output_cache,
            commands::load_terminal_output_cache,
            commands::clean_terminal_output_cache,
            commands::save_window_geometry,
            commands::load_window_geometry,
            commands::read_file_for_viewer,
            commands::read_file_for_download,
            commands::list_directory,
            commands::stat_path,
            commands::stat_paths,
            commands::get_home_directory,
            commands::get_automation_info,
            commands::load_settings_validated,
            commands::reset_settings,
            commands::get_settings_path,
            commands::subscribe_usage_probe,
            commands::unsubscribe_usage_probe,
            commands::get_usage_snapshot,
            commands::refresh_usage_probe,
            commands::get_codex_usage_snapshot,
            commands::subscribe_grok_usage_probe,
            commands::unsubscribe_grok_usage_probe,
            commands::get_grok_usage_snapshot,
            commands::refresh_grok_usage_probe,
            commands::get_remote_access_status,
            commands::set_remote_runtime_access,
            commands::get_remote_control_status,
            commands::get_remote_session_active,
            commands::get_remote_host_candidates,
            commands::get_android_pairing_status,
            commands::create_android_pairing_qr,
            commands::revoke_android_pairing,
            commands::reclaim_remote_control,
            commands::get_cloud_status,
            commands::cloud_connect_start,
            commands::cloud_disconnect,
            commands::set_sleep_inhibit,
            commands::get_app_update_status,
            commands::check_app_update,
            commands::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
