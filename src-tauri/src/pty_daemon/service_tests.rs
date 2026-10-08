use super::*;
use crate::daemon_client::DaemonClient;
use crate::daemon_reader::DaemonReader;
use crate::daemon_requests::CreateTerminal;
use crate::daemon_requests::ReadCommand;
use tokio::io::DuplexStream;

#[path = "service_observation_tests.rs"]
mod observations;

struct Fixture {
    service: Arc<DaemonService>,
    key: Capability,
    directory: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.profiles[0].command_line = if cfg!(windows) {
            "cmd.exe /Q"
        } else {
            "/bin/bash --noprofile --norc"
        }
        .into();
        settings.profiles[0].startup_command.clear();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/headless/worker.cjs");
        let service = DaemonService::new(
            Capability::from_bytes([37; 32]),
            "fixture-scope".into(),
            "fixture-runtime".into(),
            settings,
            Path::new("node"),
            &script,
        )
        .unwrap();
        Self {
            service,
            key: Capability::from_bytes([37; 32]),
            directory,
        }
    }
    async fn attach(
        &self,
    ) -> (
        DaemonClient<DuplexStream>,
        tokio::task::JoinHandle<Result<(), AppError>>,
    ) {
        let (stream, server) = tokio::io::duplex(32 * 1024);
        let task = tokio::spawn(self.service.clone().serve_connection(server));
        let client = DaemonClient::authenticate(
            stream,
            &self.key,
            "fixture-scope",
            &self.service.incarnation,
            "fixture-runtime",
        )
        .await
        .unwrap();
        (client, task)
    }
    fn spec(&self) -> CreateTerminal {
        CreateTerminal {
            id: "reconnect-fixture".into(),
            profile: self.service.settings.lock_or_err().unwrap().profiles[0]
                .name
                .clone(),
            cols: 80,
            rows: 24,
            sync_group: String::new(),
            cwd_send: Some(false),
            cwd_receive: Some(false),
            cwd: Some(self.directory.path().to_string_lossy().into_owned()),
            startup_command_override: None,
            viewer: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.service.state.terminate_child_processes();
    }
}

#[tokio::test]
async fn slow_observation_does_not_block_control_or_handoff_and_stale_result_is_rejected() {
    let fixture = Fixture::new();
    let (mut control, controller_task) = fixture.attach().await;
    let (stream, server) = tokio::io::duplex(8192);
    let observer_task = tokio::spawn(fixture.service.clone().serve_connection(server));
    let mut observer = DaemonReader::authenticate(
        stream,
        &fixture.key,
        "fixture-scope",
        "fixture-runtime",
        control.stamp.clone(),
    )
    .await
    .unwrap();
    let query = tokio::spawn(async move {
        observer
            .call(ReadCommand::Delay { milliseconds: 500 })
            .await
    });
    fixture.service.read_started.notified().await;
    tokio::time::timeout(
        std::time::Duration::from_millis(150),
        control.call(Command::Ping),
    )
    .await
    .unwrap()
    .unwrap();
    control.call(Command::Detach).await.unwrap();
    assert!(query
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("expired"));
    drop(control);
    assert!(controller_task.await.unwrap().is_err());
    assert!(observer_task.await.unwrap().is_err());
}

#[tokio::test]
async fn duplicate_create_does_not_destroy_the_existing_parser() {
    let fixture = Fixture::new();
    let (mut client, server) = fixture.attach().await;
    let created = client
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    assert!(client
        .call(Command::Create {
            spec: fixture.spec()
        })
        .await
        .is_err());
    let checkpoint = client
        .call(Command::Checkpoint {
            terminal_id: "reconnect-fixture".into(),
            generation,
        })
        .await
        .unwrap();
    assert_eq!(checkpoint["generation"], generation);
    drop(client);
    assert!(server.await.unwrap().is_err());
}

#[tokio::test]
async fn expired_cross_process_input_never_reaches_the_pty_fifo() {
    use crate::daemon_requests::PhysicalAction;
    let fixture = Fixture::new();
    let (mut client, server) = fixture.attach().await;
    let created = client
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let handle = fixture
        .service
        .state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .get("reconnect-fixture")
        .cloned()
        .unwrap();
    let before = handle.checkpoint_input_revision();
    let error = client
        .call(Command::Physical {
            operation_id: uuid::Uuid::new_v4().to_string(),
            terminal_id: "reconnect-fixture".into(),
            generation,
            expires_at: crate::daemon_clock::uptime_millis()
                .unwrap()
                .saturating_sub(1),
            action: PhysicalAction::Write {
                data: b"must-not-enter".to_vec(),
                submit: true,
            },
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("expired"));
    assert_eq!(handle.checkpoint_input_revision(), before);
    drop(client);
    assert!(server.await.unwrap().is_err());
}

#[tokio::test]
async fn a_real_job_survives_detach_and_new_gui_gets_the_same_generation() {
    let fixture = Fixture::new();
    let (mut old, old_server) = fixture.attach().await;
    let created = old
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let id = "reconnect-fixture".to_string();
    let pid = old.call(Command::Catalog).await.unwrap()[0]["childPid"].clone();
    // Output text cannot be satisfied by the shell echoing the command bytes.
    let command = if cfg!(windows) {
        "echo daemon-reconnect-^ready\r"
    } else {
        "printf 'daemon-reconnect-\\162eady\\n'\r"
    };
    old.call(Command::Write {
        terminal_id: id.clone(),
        generation,
        data: command.as_bytes().to_vec(),
    })
    .await
    .unwrap();
    old.call(Command::Detach).await.unwrap();
    let (mut new, new_server) = fixture.attach().await;
    assert!(new.stamp.epoch > old.stamp.epoch);
    assert_eq!(new.catalog[0]["generation"], generation);
    assert_eq!(new.catalog[0]["childPid"], pid);
    // A delayed destructive request from the old GUI must leave the job alive.
    assert!(old
        .call(Command::Close {
            terminal_id: id.clone(),
            generation
        })
        .await
        .is_err());
    assert!(new
        .call(Command::Write {
            terminal_id: id.clone(),
            generation: generation + 1,
            data: b"wrong".to_vec()
        })
        .await
        .is_err());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let checkpoint = new
            .call(Command::Checkpoint {
                terminal_id: id.clone(),
                generation,
            })
            .await;
        if checkpoint.ok().is_some_and(|value| {
            value["serialized"]
                .as_str()
                .is_some_and(|text| text.contains("daemon-reconnect-ready"))
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon must execute input while detached"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    new.call(Command::Close {
        terminal_id: id,
        generation,
    })
    .await
    .unwrap();
    assert!(new
        .call(Command::Catalog)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    drop(old);
    drop(new);
    assert!(old_server.await.unwrap().is_err());
    assert!(new_server.await.unwrap().is_err());
}

#[tokio::test]
async fn aborted_connection_revokes_authority_without_terminating_the_service() {
    let fixture = Fixture::new();
    let (old, server) = fixture.attach().await;
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    let (mut new, new_server) = fixture.attach().await;
    assert!(new.stamp.epoch > old.stamp.epoch);
    new.call(Command::Ping).await.unwrap();
    drop(old);
    drop(new);
    assert!(new_server.await.unwrap().is_err());
}

#[tokio::test]
async fn physical_cancellation_is_observable_while_control_is_running() {
    use crate::daemon_reader::DaemonReader;
    let fixture = Fixture::new();
    let (mut client, server) = fixture.attach().await;
    let created = client
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let (stream, source) = tokio::io::duplex(8192);
    let source_task = tokio::spawn(fixture.service.clone().serve_connection(source));
    let mut reader = DaemonReader::authenticate(
        stream,
        &fixture.service.capability,
        "fixture-scope",
        "fixture-runtime",
        client.stamp.clone(),
    )
    .await
    .unwrap();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let request_id = operation_id.clone();
    let control = tokio::spawn(async move {
        let outcome = client
            .call(Command::Physical {
                terminal_id: "reconnect-fixture".into(),
                generation,
                expires_at: crate::daemon_clock::export_deadline(
                    std::time::Instant::now() + std::time::Duration::from_secs(2),
                )
                .unwrap(),
                operation_id: request_id,
                action: PhysicalAction::Write {
                    data: b"cancel-before-submit".to_vec(),
                    submit: true,
                },
            })
            .await;
        (client, outcome)
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(200);
    loop {
        let cancelled = reader
            .call(ReadCommand::CancelPhysical {
                operation_id: operation_id.clone(),
            })
            .await
            .unwrap();
        if cancelled["cancelled"] == true {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "cancellation must not wait behind the write/submit control connection"
        );
        tokio::task::yield_now().await;
    }
    let (mut client, outcome) = control.await.unwrap();
    assert!(outcome.is_err());
    assert_eq!(
        reader.call(ReadCommand::Drained).await.unwrap()["drained"],
        true
    );
    client
        .call(Command::Close {
            terminal_id: "reconnect-fixture".into(),
            generation,
        })
        .await
        .unwrap();
    drop(reader);
    drop(client);
    assert!(server.await.unwrap().is_err());
    assert!(source_task.await.unwrap().is_err());
}

#[tokio::test]
async fn incorrect_capability_is_rejected_before_any_attachment() {
    let fixture = Fixture::new();
    let (stream, server) = tokio::io::duplex(8192);
    let task = tokio::spawn(fixture.service.clone().serve_connection(server));
    assert!(DaemonClient::authenticate(
        stream,
        &Capability::from_bytes([38; 32]),
        "fixture-scope",
        &fixture.service.incarnation,
        "fixture-runtime"
    )
    .await
    .is_err());
    assert!(task.await.unwrap().is_err());
    let (mut client, server) = fixture.attach().await;
    client.call(Command::Ping).await.unwrap();
    drop(client);
    assert!(server.await.unwrap().is_err());
}

#[tokio::test]
async fn parser_loss_rejects_new_input_and_creation_but_allows_explicit_close() {
    let fixture = Fixture::new();
    let (mut client, server) = fixture.attach().await;
    let created = client
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let handle = fixture
        .service
        .state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .get("reconnect-fixture")
        .cloned()
        .unwrap();
    let revision = handle.checkpoint_input_revision();
    fixture.service.broker.stop_parser_for_test();
    assert!(client
        .call(Command::Write {
            terminal_id: "reconnect-fixture".into(),
            generation,
            data: b"must-not-be-sent".to_vec()
        })
        .await
        .is_err());
    assert_eq!(handle.checkpoint_input_revision(), revision);
    let mut spec = fixture.spec();
    spec.id = "must-not-spawn".into();
    assert!(client.call(Command::Create { spec }).await.is_err());
    assert_eq!(
        client
            .call(Command::Catalog)
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    client
        .call(Command::Close {
            terminal_id: "reconnect-fixture".into(),
            generation,
        })
        .await
        .unwrap();
    drop(client);
    assert!(server.await.unwrap().is_err());
}

#[tokio::test]
async fn excessive_geometry_is_rejected_before_a_process_is_created() {
    let fixture = Fixture::new();
    let (mut client, server) = fixture.attach().await;
    let mut spec = fixture.spec();
    spec.cols = 4096;
    spec.rows = 4096;
    assert!(client
        .call(Command::Create { spec })
        .await
        .unwrap_err()
        .to_string()
        .contains("capacity"));
    assert!(client
        .call(Command::Catalog)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let created = client
        .call(Command::Create {
            spec: fixture.spec(),
        })
        .await
        .unwrap();
    assert!(created["generation"].as_u64().is_some());
    drop(client);
    assert!(server.await.unwrap().is_err());
}
