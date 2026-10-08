//! Bounded private RPC to the daemon's pinned VT parser process.
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::process::headless_command;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
type IoRequest = (Vec<u8>, mpsc::SyncSender<Result<Vec<u8>, std::io::Error>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerResponse {
    request_id: u64,
    result: Option<Value>,
    error: Option<String>,
}

struct WorkerIo {
    child: Child,
    requests: mpsc::SyncSender<IoRequest>,
    request_id: u64,
    failed: bool,
}

pub(crate) struct HeadlessWorker {
    io: Mutex<WorkerIo>,
}

impl HeadlessWorker {
    /// Production paths come from the immutable runtime bundle. Tests inject
    /// their own executable; production never resolves Node through PATH.
    pub(crate) fn start(node: &Path, script: &Path) -> Result<Self, AppError> {
        let mut child = headless_command(node)
            .arg("--max-old-space-size=512")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Other("headless input pipe missing".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Other("headless output pipe missing".into()))?;
        let (requests, receiver) = mpsc::sync_channel::<IoRequest>(1);
        // Both write and read may block. The caller owns the deadline and kills
        // only this parser process to release its private pipes on timeout.
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            while let Ok((frame, response)) = receiver.recv() {
                let result = (|| {
                    input.write_all(&frame)?;
                    input.flush()?;
                    let mut frame = Vec::new();
                    let count = (&mut output)
                        .take((MAX_FRAME_BYTES + 1) as u64)
                        .read_until(b'\n', &mut frame)?;
                    if count == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "headless parser closed",
                        ));
                    }
                    if frame.len() > MAX_FRAME_BYTES {
                        return Err(std::io::Error::other(
                            "headless response exceeded frame bound",
                        ));
                    }
                    Ok(frame)
                })();
                let failed = result.is_err();
                let _ = response.send(result);
                if failed {
                    break;
                }
            }
        });
        Ok(Self {
            io: Mutex::new(WorkerIo {
                child,
                requests,
                request_id: 0,
                failed: false,
            }),
        })
    }

    pub(crate) fn request(&self, request: Value) -> Result<Value, AppError> {
        self.request_with_timeout(request, REQUEST_TIMEOUT)
    }

    pub(crate) fn ensure_healthy(&self) -> Result<(), AppError> {
        let mut io = self.io.lock_or_err()?;
        if !io.failed && io.child.try_wait()?.is_some() {
            io.failed = true;
        }
        if io.failed {
            return Err(AppError::Other("headless parser is unavailable".into()));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn stop_parser_for_test(&self) {
        let mut io = self.io.lock_or_err().unwrap();
        io.child.kill().unwrap();
        io.child.wait().unwrap();
    }

    fn request_with_timeout(
        &self,
        mut request: Value,
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let mut io = self.io.lock_or_err()?;
        if io.failed {
            return Err(AppError::Other("headless parser is unavailable".into()));
        }
        io.request_id = io
            .request_id
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| AppError::Other("headless request identity overflow".into()))?;
        let id = io.request_id;
        request
            .as_object_mut()
            .ok_or_else(|| AppError::Other("headless request must be an object".into()))?
            .insert("requestId".into(), json!(id));
        let mut frame = serde_json::to_vec(&request)?;
        if frame.len() >= MAX_FRAME_BYTES {
            return Err(AppError::Other(
                "headless request exceeded frame bound".into(),
            ));
        }
        frame.push(b'\n');
        let result: Result<WorkerResponse, AppError> = (|| {
            let (reply, receiver) = mpsc::sync_channel(1);
            io.requests
                .try_send((frame, reply))
                .map_err(|_| AppError::Other("headless IO worker unavailable".into()))?;
            let frame = receiver.recv_timeout(timeout).map_err(|error| {
                AppError::Other(format!("headless parser response unavailable: {error}"))
            })??;
            let response: WorkerResponse = serde_json::from_slice(&frame)?;
            if response.request_id != id {
                return Err(AppError::Other(
                    "headless parser response identity mismatch".into(),
                ));
            }
            Ok(response)
        })();
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                io.failed = true;
                let _ = io.child.kill();
                return Err(error);
            }
        };
        match (response.result, response.error) {
            (Some(result), None) => Ok(result),
            // Operation rejection is recoverable; a stale caller must not kill
            // the parser that owns other live terminal generations.
            (None, Some(error)) => Err(AppError::Other(error)),
            _ => {
                io.failed = true;
                let _ = io.child.kill();
                Err(AppError::Other("invalid headless response envelope".into()))
            }
        }
    }
}

impl Drop for HeadlessWorker {
    fn drop(&mut self) {
        let mut io = self
            .io
            .lock_or_recover_for_discard("stopping owned headless worker");
        let _ = io.child.kill();
        let _ = io.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_generation_rejection_does_not_destroy_the_live_parser() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/headless/worker.cjs");
        let worker = HeadlessWorker::start(Path::new("node"), &script).unwrap();
        worker.request(json!({"operation":"create","terminalId":"fixture","generation":7,"cols":80,"rows":24})).unwrap();
        assert!(worker
            .request(json!({"operation":"dispose","terminalId":"fixture","generation":6}))
            .unwrap_err()
            .to_string()
            .contains("stale"));
        let checkpoint = worker
            .request(json!({"operation":"checkpoint","terminalId":"fixture","generation":7}))
            .unwrap();
        assert_eq!(checkpoint["cols"], 80);
        assert_eq!(checkpoint["rows"], 24);
    }

    #[test]
    fn a_parser_that_does_not_read_input_cannot_hold_the_caller_past_the_deadline() {
        let fixture = tempfile::tempdir().unwrap();
        let script = fixture.path().join("stalled.cjs");
        std::fs::write(
            &script,
            "process.stdin.pause();setTimeout(()=>process.exit(0),600);",
        )
        .unwrap();
        let worker = HeadlessWorker::start(Path::new("node"), &script).unwrap();
        let started = std::time::Instant::now();
        assert!(worker
            .request_with_timeout(
                json!({"payload":"a".repeat(2*1024*1024)}),
                Duration::from_millis(50)
            )
            .is_err());
        assert!(started.elapsed() < Duration::from_millis(350));
        assert!(worker
            .request(json!({}))
            .unwrap_err()
            .to_string()
            .contains("unavailable"));
    }
}
