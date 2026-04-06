#![recursion_limit = "256"]
pub mod activity;
pub mod automation_server;
pub mod cli;
pub mod clipboard;
pub mod commands;
pub mod constants;
pub mod error;
pub mod git_watcher;
pub mod ipc_server;
pub mod lock_ext;
pub mod osc;
pub mod osc_hooks;
pub mod output_buffer;
pub mod path_utils;
pub mod port_detect;
pub mod process;
pub mod pty;
pub mod settings;
pub mod state;
pub mod terminal;

use std::sync::Arc;
use tauri::image::Image;
use tauri::Manager;

pub fn run() {
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
                Ok(socket_path) => {
                    app_state
                        .ipc_socket_path
                        .lock()
                        .unwrap()
                        .replace(socket_path);
                }
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

            // Start automation HTTP server
            let app_handle = app.handle().clone();
            let auto_state = app_state.clone();
            tauri::async_runtime::spawn(async move {
                match automation_server::start(auto_state, app_handle).await {
                    Ok(port) => tracing::info!(port, "Automation API ready"),
                    Err(e) => tracing::warn!(error = %e, "Automation server failed to start"),
                }
            });

            // Set window icon (for taskbar in dev mode)
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }

            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::create_terminal_session,
            commands::resize_terminal,
            commands::write_to_terminal,
            commands::close_terminal_session,
            commands::mark_claude_terminal,
            commands::is_claude_terminal,
            commands::get_claude_session_ids,
            commands::get_sync_group_terminals,
            commands::handle_lx_message,
            commands::list_system_monospace_fonts,
            commands::load_settings,
            commands::save_settings,
            commands::load_memo,
            commands::save_memo,
            commands::open_settings_file,
            commands::submit_github_issue,
            commands::get_listening_ports,
            commands::get_git_branch,
            commands::send_os_notification,
            commands::automation_response,
            commands::get_terminal_states,
            commands::get_terminal_cwds,
            commands::get_terminal_summaries,
            commands::mark_notifications_read,
            commands::smart_paste,
            commands::clipboard_write_text,
            commands::set_terminal_cwd_receive,
            commands::update_terminal_sync_group,
            commands::save_terminal_output_cache,
            commands::load_terminal_output_cache,
            commands::clean_terminal_output_cache,
            commands::save_window_geometry,
            commands::load_window_geometry,
            commands::read_file_for_viewer,
            commands::list_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
