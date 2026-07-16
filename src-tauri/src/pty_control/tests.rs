use super::*;
use std::io;
use std::sync::{Condvar, Mutex as StdMutex};
use std::time::Duration;

struct RecordingWriter {
    bytes: Arc<StdMutex<Vec<u8>>>,
}

impl Write for RecordingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes.lock().expect("recording writer").extend(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct GatedWriter {
    started: Option<mpsc::Sender<()>>,
    gate: Arc<(StdMutex<bool>, Condvar)>,
    bytes: Arc<StdMutex<Vec<u8>>>,
}

impl Write for GatedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Some(started) = self.started.take() {
            let _ = started.send(());
            let (released, wake) = &*self.gate;
            let mut released = released.lock().expect("writer gate");
            while !*released {
                released = wake.wait(released).expect("writer gate wake");
            }
        }
        self.bytes.lock().expect("gated writer").extend(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn no_master() -> Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> {
    Arc::new(Mutex::new(None))
}

#[test]
fn control_worker_preserves_fifo_job_order() {
    let bytes = Arc::new(StdMutex::new(Vec::new()));
    let worker = PtyControlWorker::spawn(
        Box::new(RecordingWriter {
            bytes: Arc::clone(&bytes),
        }),
        no_master(),
    )
    .expect("spawn worker");
    let deadline = Instant::now() + Duration::from_secs(1);

    let first = worker.submit_write(b"first", deadline).expect("first job");
    let second = worker
        .submit_write(b"-second", deadline)
        .expect("second job");

    assert_eq!(first.result.recv().expect("first result"), Ok(()));
    assert_eq!(second.result.recv().expect("second result"), Ok(()));
    assert_eq!(&*bytes.lock().expect("recorded bytes"), b"first-second");
    worker.close();
}

#[test]
fn cancelling_active_job_never_starts_its_later_chunk() {
    let bytes = Arc::new(StdMutex::new(Vec::new()));
    let gate = Arc::new((StdMutex::new(false), Condvar::new()));
    let (started_tx, started_rx) = mpsc::channel();
    let worker = PtyControlWorker::spawn(
        Box::new(GatedWriter {
            started: Some(started_tx),
            gate: Arc::clone(&gate),
            bytes: Arc::clone(&bytes),
        }),
        no_master(),
    )
    .expect("spawn worker");
    let payload = vec![b'x'; crate::constants::PTY_WRITE_CHUNK_SIZE + 7];
    let pending = worker
        .submit_write(&payload, Instant::now() + Duration::from_secs(1))
        .expect("write job");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("physical write started");

    pending.cancelled.store(true, Ordering::Release);
    assert!(worker.cancel_job(pending.id));
    let (released, wake) = &*gate;
    *released.lock().expect("writer gate") = true;
    wake.notify_all();

    let error = pending
        .result
        .recv_timeout(Duration::from_secs(1))
        .expect("cancel acknowledgement")
        .expect_err("cancelled job must fail");
    assert!(error.contains("ownership changed"));
    assert_eq!(
        bytes.lock().expect("recorded prefix").len(),
        crate::constants::PTY_WRITE_CHUNK_SIZE
    );
    worker.close();
}

#[test]
fn queued_cancelled_job_is_rejected_without_writing() {
    let bytes = Arc::new(StdMutex::new(Vec::new()));
    let gate = Arc::new((StdMutex::new(false), Condvar::new()));
    let (started_tx, started_rx) = mpsc::channel();
    let worker = PtyControlWorker::spawn(
        Box::new(GatedWriter {
            started: Some(started_tx),
            gate: Arc::clone(&gate),
            bytes: Arc::clone(&bytes),
        }),
        no_master(),
    )
    .expect("spawn worker");
    let deadline = Instant::now() + Duration::from_secs(1);
    let first = worker.submit_write(b"first", deadline).expect("first job");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first write started");
    let second = worker
        .submit_write(b"second", deadline)
        .expect("second job");
    second.cancelled.store(true, Ordering::Release);
    assert!(!worker.cancel_job(second.id));

    let (released, wake) = &*gate;
    *released.lock().expect("writer gate") = true;
    wake.notify_all();
    assert_eq!(first.result.recv().expect("first result"), Ok(()));
    let error = second
        .result
        .recv_timeout(Duration::from_secs(1))
        .expect("second result")
        .expect_err("queued cancellation must fail");
    assert!(error.contains("ownership changed"));
    assert_eq!(&*bytes.lock().expect("recorded bytes"), b"first");
    worker.close();
}
