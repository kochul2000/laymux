use super::*;
use crate::pty_daemon::gateway::{ConnectionIdentity, DaemonGateway};
use crate::pty_daemon::transport::{private_directory, Listener};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gui_observations_use_the_authenticated_source_without_a_local_pty() {
    let fixture = Fixture::new();
    let (mut control, controller_task) = fixture.attach().await;
    let created = control
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let private = fixture.directory.path().join("ipc");
    private_directory(&private).unwrap();
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\laymux-observation-{}", uuid::Uuid::new_v4())
    } else {
        private.join("daemon.sock").to_string_lossy().into_owned()
    };
    let mut listener = Listener::bind(&endpoint).unwrap();
    let service = fixture.service.clone();
    let acceptor = tokio::spawn(async move {
        loop {
            let stream = listener.accept().await.unwrap();
            let service = service.clone();
            tokio::spawn(async move {
                let _ = service.serve_connection(stream).await;
            });
        }
    });
    let gateway = DaemonGateway::observer_for_test(ConnectionIdentity {
        endpoint,
        scope: fixture.service.scope.clone(),
        runtime: fixture.service.runtime.clone(),
        stamp: control.stamp.clone(),
        capability: Capability::from_bytes([37; 32]),
    });
    let gui = Arc::new(AppState::new());
    assert!(gui.daemon.set(gateway).is_ok());
    let expected_cwd = fixture.service.state.terminals.lock_or_err().unwrap()["reconnect-fixture"]
        .cwd
        .clone()
        .unwrap();
    // Tauri's #[command(async)] sync functions execute inside a Tokio task,
    // not spawn_blocking. Exercise that exact caller context.
    let cwds = crate::commands::get_terminal_cwds_impl(&gui).unwrap();
    let attributions =
        crate::commands::get_terminal_session_attributions_impl(None, None, None, &gui).unwrap();
    assert_eq!(cwds.get("reconnect-fixture"), Some(&expected_cwd));
    assert_eq!(attributions["reconnect-fixture"].generation, generation);
    assert_eq!(
        attributions["reconnect-fixture"].state,
        crate::commands::SessionAttributionState::NoAgent
    );
    assert!(gui.pty_handles.lock_or_err().unwrap().is_empty());

    // The same bridge is used by plain worker threads and may also be called
    // from a current-thread runtime. Neither may nest or drop a runtime in
    // an async context. Keep the source running on its independent executor.
    tokio::task::block_in_place(|| {
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    assert_eq!(crate::commands::get_terminal_cwds_impl(&gui).unwrap(), cwds);
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    runtime.block_on(async {
                        assert_eq!(crate::commands::get_terminal_cwds_impl(&gui).unwrap(), cwds);
                    });
                })
                .join()
                .unwrap();
        });
    });

    // Revoking the source attachment must fail the lookup. An empty local
    // mirror cannot be substituted as a successful observation.
    control.call(Command::Detach).await.unwrap();
    assert!(crate::commands::get_terminal_cwds_impl(&gui).is_err());
    assert!(
        crate::commands::get_terminal_session_attributions_impl(None, None, None, &gui).is_err()
    );
    acceptor.abort();
    drop(control);
    assert!(controller_task.await.unwrap().is_err());
}
