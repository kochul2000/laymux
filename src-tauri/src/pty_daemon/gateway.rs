//! GUI-owned connection adapter. Closing it never closes daemon-owned PTYs.
use super::auth::{AttachmentStamp, Capability};
use super::client::DaemonClient;
use super::launcher::{prepare, PreparedService};
use super::reader::DaemonReader;
use super::requests::{Command, ReadCommand};
use super::transport::connect;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::settings::Settings;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CONTROL_QUEUE_CAPACITY: usize = 128;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

enum Reply {
    Async(tokio::sync::oneshot::Sender<Result<Value, String>>),
    Sync(std::sync::mpsc::SyncSender<Result<Value, String>>),
}
impl Reply {
    fn send(self, outcome: Result<Value, String>) {
        match self {
            Self::Async(sender) => {
                let _ = sender.send(outcome);
            }
            Self::Sync(sender) => {
                let _ = sender.send(outcome);
            }
        }
    }
}

struct Call {
    command: Command,
    deadline: Instant,
    reply: Reply,
}

pub(crate) struct ConnectionIdentity {
    pub endpoint: String,
    pub scope: String,
    pub runtime: String,
    pub stamp: AttachmentStamp,
    pub capability: Capability,
}

pub(crate) struct DaemonGateway {
    pub(super) projections:
        Mutex<std::collections::HashMap<String, Arc<super::projection::Projection>>>,
    sender: tokio::sync::mpsc::Sender<Call>,
    identity: Mutex<Option<ConnectionIdentity>>,
    ready: tokio::sync::watch::Receiver<Result<bool, String>>,
    alive: AtomicBool,
    stopped: AtomicBool,
}

impl DaemonGateway {
    pub(crate) fn start(
        settings: Settings,
        executable: PathBuf,
        resources: PathBuf,
    ) -> Result<Arc<Self>, AppError> {
        let (sender, receiver) = tokio::sync::mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let (ready_sender, ready) = tokio::sync::watch::channel(Ok(false));
        let gateway = Arc::new(Self {
            projections: Mutex::new(std::collections::HashMap::new()),
            sender,
            identity: Mutex::new(None),
            ready,
            alive: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        });
        let worker = Arc::downgrade(&gateway);
        std::thread::Builder::new()
            .name("laymux-daemon-gateway".into())
            .spawn(move || {
                let outcome = (|| {
                    let prepared = prepare(&settings, &executable, &resources)?;
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    runtime.block_on(run(
                        worker.clone(),
                        prepared,
                        receiver,
                        ready_sender.clone(),
                    ))
                })();
                if let Err(error) = outcome {
                    if let Some(gateway) = worker.upgrade() {
                        gateway.alive.store(false, Ordering::Release);
                    }
                    let _ = ready_sender.send_replace(Err(error.to_string()));
                }
            })?;
        Ok(gateway)
    }

    pub(crate) async fn wait_ready(&self) -> Result<(), String> {
        let mut ready = self.ready.clone();
        tokio::time::timeout(STARTUP_TIMEOUT, async {
            loop {
                match ready.borrow().clone() {
                    Ok(true) => return Ok(()),
                    Err(error) => return Err(error),
                    Ok(false) => {}
                }
                ready
                    .changed()
                    .await
                    .map_err(|_| "daemon startup channel closed".to_string())?;
            }
        })
        .await
        .map_err(|_| "daemon startup deadline exceeded".to_string())?
    }

    pub(crate) async fn call(&self, command: Command) -> Result<Value, String> {
        self.wait_ready().await?;
        if !self.alive.load(Ordering::Acquire) {
            return Err("daemon connection unavailable".into());
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        self.sender
            .try_send(Call {
                command,
                deadline: Instant::now() + STARTUP_TIMEOUT,
                reply: Reply::Async(reply),
            })
            .map_err(|_| "daemon control queue unavailable".to_string())?;
        response
            .await
            .map_err(|_| "daemon control outcome unavailable".to_string())?
    }

    pub(crate) fn call_blocking(
        &self,
        command: Command,
        deadline: Instant,
    ) -> Result<Value, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("daemon connection unavailable".into());
        }
        let (reply, response) = std::sync::mpsc::sync_channel(1);
        self.sender
            .try_send(Call {
                command,
                deadline,
                reply: Reply::Sync(reply),
            })
            .map_err(|_| "daemon control queue unavailable".to_string())?;
        response
            .recv_timeout(
                deadline.saturating_duration_since(Instant::now()) + Duration::from_secs(5),
            )
            .map_err(|_| "daemon control outcome is ambiguous; input was not retried".to_string())?
    }

    pub(crate) async fn read(&self, query: ReadCommand) -> Result<Value, String> {
        self.wait_ready().await?;
        if !self.alive.load(Ordering::Acquire) {
            return Err("daemon connection unavailable".into());
        }
        let (endpoint, scope, runtime, stamp, key) = {
            let identity = self.identity.lock_or_err().map_err(String::from)?;
            let identity = identity
                .as_ref()
                .ok_or_else(|| "daemon connection identity unavailable".to_string())?;
            (
                identity.endpoint.clone(),
                identity.scope.clone(),
                identity.runtime.clone(),
                identity.stamp.clone(),
                Capability::from_bytes(*identity.capability.bytes()),
            )
        };
        let stream = connect(&endpoint).await.map_err(String::from)?;
        let mut reader = DaemonReader::authenticate(stream, &key, &scope, &runtime, stamp)
            .await
            .map_err(String::from)?;
        let outcome = reader.call(query).await.map_err(String::from);
        if !self.alive.load(Ordering::Acquire) {
            return Err("daemon owner connection was lost during observation".into());
        }
        outcome
    }

    pub(crate) fn read_blocking(&self, query: ReadCommand) -> Result<Value, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(self.read(query))
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
    pub(crate) fn connected(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
    pub(crate) fn incarnation(&self) -> Result<String, String> {
        self.identity
            .lock_or_err()
            .map_err(String::from)?
            .as_ref()
            .map(|identity| identity.stamp.incarnation.clone())
            .ok_or_else(|| "daemon identity unavailable".into())
    }

    pub(crate) fn physical_executor(
        self: &Arc<Self>,
        id: String,
        generation: u64,
    ) -> crate::pty_control::ExternalControlExecutor {
        let gateway = self.clone();
        Arc::new(move |action, deadline, cancelled, complete| {
            let expires_at = match super::clock::export_deadline(deadline) {
                Ok(expiry) => expiry,
                Err(error) => {
                    complete.store(true, Ordering::Release);
                    return Err(error.to_string());
                }
            };
            let operation_id = uuid::Uuid::new_v4().to_string();
            let done = Arc::new(AtomicBool::new(false));
            let monitor_done = done.clone();
            let monitor = gateway.clone();
            let operation = operation_id.clone();
            let monitor_thread = std::thread::Builder::new()
                .name("laymux-daemon-cancel".into())
                .spawn(move || {
                    while !monitor_done.load(Ordering::Acquire) && monitor.connected() {
                        if cancelled.load(Ordering::Acquire) {
                            let _ = monitor.read_blocking(ReadCommand::CancelPhysical {
                                operation_id: operation.clone(),
                            });
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                });
            if let Err(error) = monitor_thread {
                complete.store(true, Ordering::Release);
                return Err(format!("daemon cancellation monitor unavailable: {error}"));
            }
            let action = match action {
                crate::pty_control::ExternalControlAction::Write { data, submit } => {
                    super::requests::PhysicalAction::Write { data, submit }
                }
                crate::pty_control::ExternalControlAction::Resize { cols, rows } => {
                    super::requests::PhysicalAction::Resize { cols, rows }
                }
            };
            let result = gateway.call_blocking(
                Command::Physical {
                    operation_id,
                    terminal_id: id.clone(),
                    generation,
                    expires_at,
                    action,
                },
                deadline,
            );
            done.store(true, Ordering::Release);
            if result.is_ok()
                || gateway
                    .read_blocking(ReadCommand::Drained)
                    .ok()
                    .is_some_and(|value| value["drained"] == true)
            {
                complete.store(true, Ordering::Release);
            } else {
                let monitor = gateway.clone();
                let _ = std::thread::Builder::new()
                    .name("laymux-daemon-drain".into())
                    .spawn(move || {
                        while monitor.connected() {
                            if monitor
                                .read_blocking(ReadCommand::Drained)
                                .ok()
                                .is_some_and(|value| value["drained"] == true)
                            {
                                complete.store(true, Ordering::Release);
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(25));
                        }
                    });
            }
            result.map(|_| ())
        })
    }
}

async fn run(
    gateway: std::sync::Weak<DaemonGateway>,
    prepared: PreparedService,
    mut receiver: tokio::sync::mpsc::Receiver<Call>,
    ready: tokio::sync::watch::Sender<Result<bool, String>>,
) -> Result<(), AppError> {
    let key = Capability::from_bytes(prepared.bootstrap.capability.0);
    let stream = connect(&prepared.discovery.endpoint).await?;
    let mut client = DaemonClient::authenticate(
        stream,
        &key,
        &prepared.discovery.scope,
        &prepared.discovery.incarnation,
        &prepared.discovery.runtime,
    )
    .await?;
    let owner = gateway
        .upgrade()
        .ok_or_else(|| AppError::Other("GUI gateway was dropped during startup".into()))?;
    *owner.identity.lock_or_err()? = Some(ConnectionIdentity {
        endpoint: prepared.discovery.endpoint.clone(),
        scope: prepared.discovery.scope.clone(),
        runtime: prepared.discovery.runtime.clone(),
        stamp: client.stamp.clone(),
        capability: key,
    });
    owner.alive.store(true, Ordering::Release);
    let _ = ready.send_replace(Ok(true));
    drop(owner);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(250));
    loop {
        let Some(owner) = gateway.upgrade() else {
            break;
        };
        if owner.stopped.load(Ordering::Acquire) {
            break;
        }
        drop(owner);
        tokio::select! {
            biased;
            _ = heartbeat.tick() => { client.call(Command::Ping).await?; },
            call = receiver.recv() => {
                let Some(call) = call else { break; };
                if Instant::now() >= call.deadline { call.reply.send(Err("daemon queued operation deadline expired".into())); continue; }
                let outcome = client.call(call.command).await.map_err(String::from);
                call.reply.send(outcome);
                if client.failed() { return Err(AppError::Other("daemon control transport unavailable".into())); }
            },
        }
    }
    if let Some(owner) = gateway.upgrade() {
        owner.alive.store(false, Ordering::Release);
    }
    Ok(())
}
