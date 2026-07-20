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

/// Records each `write()` call as its own chunk, so tests can tell a split
/// body+CR (two writes) apart from a fused `body\r` (one write).
struct ChunkWriter {
    chunks: Arc<StdMutex<Vec<Vec<u8>>>>,
}

impl Write for ChunkWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.chunks.lock().expect("chunk writer").push(buf.to_vec());
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

    let first = worker
        .submit_write(b"first", false, deadline)
        .expect("first job");
    let second = worker
        .submit_write(b"-second", false, deadline)
        .expect("second job");

    assert_eq!(first.result.recv().expect("first result"), Ok(()));
    assert_eq!(second.result.recv().expect("second result"), Ok(()));
    assert_eq!(&*bytes.lock().expect("recorded bytes"), b"first-second");
    worker.close();
}

/// #490: a submit job writes the body and the CR as TWO distinct writes (not a
/// fused `body\r`), gapped by the delay, and because it is one atomic FIFO job a
/// write queued behind it lands AFTER the CR — never between the body and the
/// CR. This is the property the earlier app-level split (two jobs) could not
/// guarantee. Per-`write()` chunk recording is what distinguishes split from
/// fused; a concatenating writer would pass even on a fused regression.
#[test]
fn submit_write_appends_gapped_cr_as_separate_write_before_next_job() {
    let chunks = Arc::new(StdMutex::new(Vec::new()));
    let worker = PtyControlWorker::spawn(
        Box::new(ChunkWriter {
            chunks: Arc::clone(&chunks),
        }),
        no_master(),
    )
    .expect("spawn worker");
    let deadline = Instant::now() + Duration::from_secs(5);

    let started = Instant::now();
    let submit = worker
        .submit_write(b"cmd", true, deadline)
        .expect("submit job");
    let raw = worker.submit_write(b"x", false, deadline).expect("raw job");
    assert_eq!(submit.result.recv().expect("submit result"), Ok(()));
    assert_eq!(raw.result.recv().expect("raw result"), Ok(()));

    // Body, CR, then the following raw write — three separate writes, in order.
    assert_eq!(
        &*chunks.lock().expect("chunks"),
        &[b"cmd".to_vec(), b"\r".to_vec(), b"x".to_vec()]
    );
    // The gap actually elapsed — guards against the CR being fused or un-delayed.
    assert!(
        started.elapsed()
            >= Duration::from_millis(ENTER_SUBMIT_CR_DELAY_MS)
                .saturating_sub(Duration::from_millis(50))
    );
    worker.close();
}

/// A lone Enter (submit with an empty body) emits just the CR, with no gap.
#[test]
fn submit_write_with_empty_body_emits_only_cr() {
    let chunks = Arc::new(StdMutex::new(Vec::new()));
    let worker = PtyControlWorker::spawn(
        Box::new(ChunkWriter {
            chunks: Arc::clone(&chunks),
        }),
        no_master(),
    )
    .expect("spawn worker");
    let deadline = Instant::now() + Duration::from_secs(1);

    let lone = worker
        .submit_write(b"", true, deadline)
        .expect("lone enter job");
    assert_eq!(lone.result.recv().expect("lone result"), Ok(()));
    assert_eq!(&*chunks.lock().expect("chunks"), &[b"\r".to_vec()]);
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
        .submit_write(&payload, false, Instant::now() + Duration::from_secs(1))
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
    let first = worker
        .submit_write(b"first", false, deadline)
        .expect("first job");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first write started");
    let second = worker
        .submit_write(b"second", false, deadline)
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
