//! This crate provides a cross platform API for working with the
//! psuedo terminal (pty) interfaces provided by the system.
//! Unlike other crates in this space, this crate provides a set
//! of traits that allow selecting from different implementations
//! at runtime.
//! This crate is part of [wezterm](https://github.com/wez/wezterm).
//!
//! ```no_run
//! use portable_pty::{CommandBuilder, PtySize, native_pty_system, PtySystem};
//! use anyhow::Error;
//!
//! // Use the native pty implementation for the system
//! let pty_system = native_pty_system();
//!
//! // Create a new pty
//! let mut pair = pty_system.openpty(PtySize {
//!     rows: 24,
//!     cols: 80,
//!     // Not all systems support pixel_width, pixel_height,
//!     // but it is good practice to set it to something
//!     // that matches the size of the selected font.  That
//!     // is more complex than can be shown here in this
//!     // brief example though!
//!     pixel_width: 0,
//!     pixel_height: 0,
//! })?;
//!
//! // Spawn a shell into the pty
//! let cmd = CommandBuilder::new("bash");
//! let child = pair.slave.spawn_command(cmd)?;
//!
//! // Read and parse output from the pty with reader
//! let mut reader = pair.master.try_clone_reader()?;
//!
//! // Send data to the pty by writing to the master
//! writeln!(pair.master.take_writer()?, "ls -l\r\n")?;
//! # Ok::<(), Error>(())
//! ```
//!
use anyhow::Error;
use downcast_rs::{impl_downcast, Downcast};
#[cfg(feature = "serde_support")]
use serde_derive::*;
use std::io::Result as IoResult;
#[cfg(windows)]
use std::os::windows::prelude::{AsRawHandle, RawHandle};
use std::time::Duration;

/// A single result from a generation-aware interruptible PTY reader.
///
/// `Wake` is control-plane liveness only. It does not identify byte
/// provenance and must never be used as a resize boundary.
#[derive(Debug)]
pub enum PtyReadEvent {
    Data(Vec<u8>),
    Wake(u64),
    Eof,
    Failure(std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyWakeOutcome {
    Acked,
    Terminal,
}

pub trait InterruptiblePtyReader: Send {
    /// Every call for one reader must run on the same OS thread. Windows
    /// validates this because its cancellation handle is thread-specific.
    fn read_event(&mut self) -> PtyReadEvent;
}

pub trait InterruptiblePtyReaderControl: Send + Sync {
    fn terminal_generation(&self) -> u64;

    fn wake(
        &self,
        terminal_generation: u64,
        wake_generation: u64,
        timeout: Duration,
    ) -> IoResult<PtyWakeOutcome>;

    /// Test-only native observation used to prove that pipe emptiness is not
    /// an output-provenance boundary.
    #[cfg(test)]
    fn output_empty_for_test(&self) -> IoResult<bool>;

    /// Test-only native fault injection. Implementations must interrupt the
    /// currently blocked OS read without admitting a Wake generation so the
    /// adapter emits `Failure` and then remains fused at `Eof`.
    #[cfg(test)]
    fn inject_failure_for_test(&self, timeout: Duration) -> IoResult<()>;
}

pub struct InterruptiblePtyReaderPair {
    pub reader: Box<dyn InterruptiblePtyReader>,
    pub control: Box<dyn InterruptiblePtyReaderControl>,
}

pub mod cmdbuilder;
pub use cmdbuilder::CommandBuilder;

#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod win;

pub mod serial;

/// Represents the size of the visible display area in the pty
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde_support", derive(Serialize, Deserialize))]
pub struct PtySize {
    /// The number of lines of text
    pub rows: u16,
    /// The number of columns of text
    pub cols: u16,
    /// The width of a cell in pixels.  Note that some systems never
    /// fill this value and ignore it.
    pub pixel_width: u16,
    /// The height of a cell in pixels.  Note that some systems never
    /// fill this value and ignore it.
    pub pixel_height: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// Represents the master/control end of the pty
pub trait MasterPty {
    /// Inform the kernel and thus the child process that the window resized.
    /// It will update the winsize information maintained by the kernel,
    /// and generate a signal for the child to notice and update its state.
    fn resize(&self, size: PtySize) -> Result<(), Error>;
    /// Retrieves the size of the pty as known by the kernel
    fn get_size(&self) -> Result<PtySize, Error>;
    /// Obtain a readable handle; output from the slave(s) is readable
    /// via this stream.
    fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, Error>;

    /// Obtain the native generation-aware interruptible reader seam.
    ///
    /// Implementations without an audited wake primitive return `Ok(None)`.
    fn try_clone_interruptible_reader(
        &self,
        _terminal_generation: u64,
    ) -> Result<Option<InterruptiblePtyReaderPair>, Error> {
        Ok(None)
    }
    /// Obtain a writable handle; writing to it will send data to the
    /// slave end.
    /// Dropping the writer will send EOF to the slave end.
    /// It is invalid to take the writer more than once.
    fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, Error>;

    /// If applicable to the type of the tty, return the local process id
    /// of the process group or session leader
    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<libc::pid_t>;

    /// If get_termios() and process_group_leader() are both implemented and
    /// return Some, then as_raw_fd() should return the same underlying fd
    /// associated with the stream. This is to enable applications that
    /// "know things" to query similar information for themselves.
    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<unix::RawFd>;

    /// If applicable to the type of the tty, return the termios
    /// associated with the stream
    #[cfg(unix)]
    fn get_termios(&self) -> Option<nix::sys::termios::Termios> {
        None
    }
}

/// Represents a child process spawned into the pty.
/// This handle can be used to wait for or terminate that child process.
pub trait Child: std::fmt::Debug + ChildKiller {
    /// Poll the child to see if it has completed.
    /// Does not block.
    /// Returns None if the child has not yet terminated,
    /// else returns its exit status.
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>>;
    /// Blocks execution until the child process has completed,
    /// yielding its exit status.
    fn wait(&mut self) -> IoResult<ExitStatus>;
    /// Returns the process identifier of the child process,
    /// if applicable
    fn process_id(&self) -> Option<u32>;
    /// Returns the process handle of the child process, if applicable.
    /// Only available on Windows.
    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle>;
}

/// Represents the ability to signal a Child to terminate
pub trait ChildKiller: std::fmt::Debug {
    /// Terminate the child process
    fn kill(&mut self) -> IoResult<()>;

    /// Clone an object that can be split out from the Child in order
    /// to send it signals independently from a thread that may be
    /// blocked in `.wait`.
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>;
}

/// Represents the slave side of a pty.
/// Can be used to spawn processes into the pty.
pub trait SlavePty {
    /// Spawns the command specified by the provided CommandBuilder
    fn spawn_command(&self, cmd: CommandBuilder) -> Result<Box<dyn Child + Send + Sync>, Error>;
}

/// Represents the exit status of a child process.
#[derive(Debug, Clone)]
pub struct ExitStatus {
    code: u32,
    signal: Option<String>,
}

impl ExitStatus {
    /// Construct an ExitStatus from a process return code
    pub fn with_exit_code(code: u32) -> Self {
        Self { code, signal: None }
    }

    /// Construct an ExitStatus from a signal name
    pub fn with_signal(signal: &str) -> Self {
        Self {
            code: 1,
            signal: Some(signal.to_string()),
        }
    }

    /// Returns true if the status indicates successful completion
    pub fn success(&self) -> bool {
        match self.signal {
            None => self.code == 0,
            Some(_) => false,
        }
    }

    /// Returns the exit code that this ExitStatus was constructed with
    pub fn exit_code(&self) -> u32 {
        self.code
    }
}

impl From<std::process::ExitStatus> for ExitStatus {
    fn from(status: std::process::ExitStatus) -> ExitStatus {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;

            if let Some(signal) = status.signal() {
                let signame = unsafe { libc::strsignal(signal) };
                let signal = if signame.is_null() {
                    format!("Signal {}", signal)
                } else {
                    let signame = unsafe { std::ffi::CStr::from_ptr(signame) };
                    signame.to_string_lossy().to_string()
                };

                return ExitStatus {
                    code: status.code().map(|c| c as u32).unwrap_or(1),
                    signal: Some(signal),
                };
            }
        }

        let code =
            status
                .code()
                .map(|c| c as u32)
                .unwrap_or_else(|| if status.success() { 0 } else { 1 });

        ExitStatus { code, signal: None }
    }
}

impl std::fmt::Display for ExitStatus {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.success() {
            write!(fmt, "Success")
        } else {
            match &self.signal {
                Some(sig) => write!(fmt, "Terminated by {}", sig),
                None => write!(fmt, "Exited with code {}", self.code),
            }
        }
    }
}

pub struct PtyPair {
    // slave is listed first so that it is dropped first.
    // The drop order is stable and specified by rust rfc 1857
    pub slave: Box<dyn SlavePty + Send>,
    pub master: Box<dyn MasterPty + Send>,
}

/// The `PtySystem` trait allows an application to work with multiple
/// possible Pty implementations at runtime.  This is important on
/// Windows systems which have a variety of implementations.
pub trait PtySystem: Downcast {
    /// Create a new Pty instance with the window size set to the specified
    /// dimensions.  Returns a (master, slave) Pty pair.  The master side
    /// is used to drive the slave side.
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair>;
}
impl_downcast!(PtySystem);

impl Child for std::process::Child {
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
        std::process::Child::try_wait(self).map(|status| status.map(Into::into))
    }

    fn wait(&mut self) -> IoResult<ExitStatus> {
        std::process::Child::wait(self).map(Into::into)
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.id())
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        Some(std::os::windows::io::AsRawHandle::as_raw_handle(self))
    }
}

#[derive(Debug)]
struct ProcessSignaller {
    pid: Option<u32>,

    #[cfg(windows)]
    handle: Option<filedescriptor::OwnedHandle>,
}

#[cfg(windows)]
impl ChildKiller for ProcessSignaller {
    fn kill(&mut self) -> IoResult<()> {
        if let Some(handle) = &self.handle {
            unsafe {
                if winapi::um::processthreadsapi::TerminateProcess(handle.as_raw_handle() as _, 127)
                    == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
        }
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self {
            pid: self.pid,
            handle: self.handle.as_ref().and_then(|h| h.try_clone().ok()),
        })
    }
}

#[cfg(unix)]
impl ChildKiller for ProcessSignaller {
    fn kill(&mut self) -> IoResult<()> {
        if let Some(pid) = self.pid {
            let result = unsafe { libc::kill(pid as i32, libc::SIGHUP) };
            if result != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self { pid: self.pid })
    }
}

impl ChildKiller for std::process::Child {
    fn kill(&mut self) -> IoResult<()> {
        #[cfg(unix)]
        {
            // On unix, we send the SIGHUP signal instead of trying to kill
            // the process. The default behavior of a process receiving this
            // signal is to be killed unless it configured a signal handler.
            let result = unsafe { libc::kill(self.id() as i32, libc::SIGHUP) };
            if result != 0 {
                return Err(std::io::Error::last_os_error());
            }

            // We successfully delivered SIGHUP, but the semantics of Child::kill
            // are that on success the process is dead or shortly about to
            // terminate.  Since SIGUP doesn't guarantee termination, we
            // give the process a bit of a grace period to shutdown or do whatever
            // it is doing in its signal handler befre we proceed with the
            // full on kill.
            for attempt in 0..5 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }

                if let Ok(Some(_)) = self.try_wait() {
                    // It completed, so report success!
                    return Ok(());
                }
            }

            // it's still alive after a grace period, so proceed with a kill
        }

        std::process::Child::kill(self)
    }

    #[cfg(windows)]
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        struct RawDup(RawHandle);
        impl AsRawHandle for RawDup {
            fn as_raw_handle(&self) -> RawHandle {
                self.0
            }
        }

        Box::new(ProcessSignaller {
            pid: self.process_id(),
            handle: Child::as_raw_handle(self)
                .as_ref()
                .and_then(|h| filedescriptor::OwnedHandle::dup(&RawDup(*h)).ok()),
        })
    }

    #[cfg(unix)]
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(ProcessSignaller {
            pid: self.process_id(),
        })
    }
}

pub fn native_pty_system() -> Box<dyn PtySystem + Send> {
    Box::new(NativePtySystem::default())
}

#[cfg(unix)]
pub type NativePtySystem = unix::UnixPtySystem;
#[cfg(windows)]
pub type NativePtySystem = win::conpty::ConPtySystem;

#[cfg(all(test, any(windows, target_os = "linux")))]
mod interruptible_native_tests {
    use super::*;
    use std::io::Write;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    struct KillChildOnDrop(Option<Box<dyn ChildKiller + Send + Sync>>);

    impl Drop for KillChildOnDrop {
        fn drop(&mut self) {
            if let Some(mut killer) = self.0.take() {
                let _ = killer.kill();
            }
        }
    }

    #[test]
    fn native_pty_preserves_data_and_acknowledges_an_idle_wake() {
        let system = native_pty_system();
        let pair = system.openpty(PtySize::default()).unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let reader_pair = pair
            .master
            .try_clone_interruptible_reader(91)
            .unwrap()
            .expect("native interruptible reader");
        let InterruptiblePtyReaderPair { reader, control } = reader_pair;
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(control);

        // The input writer and slave already exist, yet an OS-level
        // poll/PeekNamedPipe observation reports no output. A later producer
        // can still enqueue bytes, so this cannot be a provenance boundary.
        assert!(control.output_empty_for_test().unwrap());

        #[cfg(windows)]
        let command = {
            let mut command = CommandBuilder::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile"]);
            command
        };
        #[cfg(target_os = "linux")]
        let command = CommandBuilder::new("/bin/sh");
        let mut child = pair.slave.spawn_command(command).unwrap();
        // A failed assertion must not leave the native shell behind. The PTY
        // master still drops during unwind and releases a blocked pump read.
        let mut child_cleanup = KillChildOnDrop(Some(child.clone_killer()));
        drop(pair.slave);

        // A real OS output queue can contain old bytes across a successful
        // resize/get-size round trip. This is a negative provenance witness,
        // not an attempt to make resize exact.
        writer
            .write_all(
                b"echo PORTABLE_PTY_DELAYED_AFTER_EMPTY\r\necho PORTABLE_PTY_QUEUED_BEFORE_RESIZE\r\n",
            )
            .unwrap();
        writer.flush().unwrap();
        let queued_deadline = Instant::now() + Duration::from_secs(10);
        while control.output_empty_for_test().unwrap() {
            assert!(
                Instant::now() < queued_deadline,
                "native PTY output never became queued"
            );
            thread::sleep(Duration::from_millis(1));
        }
        let resized = PtySize {
            rows: 31,
            cols: 97,
            pixel_width: 0,
            pixel_height: 0,
        };
        pair.master.resize(resized).unwrap();
        assert_eq!(pair.master.get_size().unwrap(), resized);
        assert!(
            !control.output_empty_for_test().unwrap(),
            "resize/get-size unexpectedly consumed queued output"
        );

        let (event_tx, event_rx) = mpsc::channel();
        let pump = thread::spawn(move || {
            let mut reader = reader;
            loop {
                let event = reader.read_event();
                let terminal = matches!(event, PtyReadEvent::Eof | PtyReadEvent::Failure(_));
                if event_tx.send(event).is_err() || terminal {
                    break;
                }
            }
        });

        writer
            .write_all(b"echo PORTABLE_PTY_INTERRUPTIBLE_DATA_OK\r\n")
            .unwrap();
        writer.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains("PORTABLE_PTY_INTERRUPTIBLE_DATA_OK") {
            let event = event_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("native PTY marker output");
            match event {
                PtyReadEvent::Data(bytes) => output.extend(bytes),
                other => panic!("unexpected event before marker: {:?}", other),
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("PORTABLE_PTY_DELAYED_AFTER_EMPTY"));
        assert!(String::from_utf8_lossy(&output).contains("PORTABLE_PTY_QUEUED_BEFORE_RESIZE"));

        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            control.wake(91, 1, Duration::from_secs(2)).unwrap(),
            PtyWakeOutcome::Acked
        );
        loop {
            match event_rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                PtyReadEvent::Data(bytes) => output.extend(bytes),
                PtyReadEvent::Wake(1) => break,
                other => panic!("unexpected event while awaiting wake: {:?}", other),
            }
        }

        writer.write_all(b"exit\r\n").unwrap();
        writer.flush().unwrap();
        child.wait().unwrap();
        child_cleanup.0.take();
        drop(writer);
        // ConPTY keeps its output pipe alive with the HPCON. EOF is defined by
        // child exit plus master teardown, not by the shell command alone.
        drop(pair.master);
        let terminal = loop {
            match event_rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                PtyReadEvent::Data(bytes) => output.extend(bytes),
                event @ (PtyReadEvent::Eof | PtyReadEvent::Failure(_)) => break event,
                PtyReadEvent::Wake(generation) => {
                    panic!("unexpected extra wake generation {}", generation)
                }
            }
        };
        assert!(matches!(terminal, PtyReadEvent::Eof));
        pump.join().unwrap();
    }

    #[test]
    fn native_fault_emits_one_failure_and_then_fused_eof() {
        let system = native_pty_system();
        let pair = system.openpty(PtySize::default()).unwrap();
        #[cfg(windows)]
        let command = {
            let mut command = CommandBuilder::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile"]);
            command
        };
        #[cfg(target_os = "linux")]
        let command = CommandBuilder::new("/bin/sh");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut child_cleanup = KillChildOnDrop(Some(child.clone_killer()));
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        let reader_pair = pair
            .master
            .try_clone_interruptible_reader(92)
            .unwrap()
            .expect("native interruptible reader");
        let InterruptiblePtyReaderPair { reader, control } = reader_pair;
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(control);
        let (event_tx, event_rx) = mpsc::channel();
        let pump = thread::spawn(move || {
            let mut reader = reader;
            loop {
                match reader.read_event() {
                    PtyReadEvent::Data(_) => continue,
                    event @ PtyReadEvent::Failure(_) => {
                        event_tx.send(event).unwrap();
                        event_tx.send(reader.read_event()).unwrap();
                        break;
                    }
                    event => {
                        event_tx.send(event).unwrap();
                        break;
                    }
                }
            }
        });

        control
            .inject_failure_for_test(Duration::from_secs(2))
            .unwrap();
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            PtyReadEvent::Failure(_)
        ));
        assert!(matches!(
            event_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            PtyReadEvent::Eof
        ));
        pump.join().unwrap();

        writer.write_all(b"exit\r\n").unwrap();
        writer.flush().unwrap();
        child.wait().unwrap();
        child_cleanup.0.take();
        drop(writer);
        drop(pair.master);
    }
}
