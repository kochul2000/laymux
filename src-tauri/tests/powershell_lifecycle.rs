#![cfg(windows)]

use laymux_lib::osc::{iter_osc_events, OscEvent};
use laymux_lib::pty::{spawn_pty, PtyHandle, PtyOutputControl};
use laymux_lib::terminal::{TerminalConfig, TerminalSession};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

struct Shell {
    handle: PtyHandle,
    rx: Receiver<Vec<u8>>,
    bytes: Vec<u8>,
}

impl Drop for Shell {
    fn drop(&mut self) {
        let _ = self.handle.terminate();
    }
}

impl Shell {
    fn new() -> Self {
        let session = TerminalSession::new(
            "powershell-lifecycle-test".into(),
            TerminalConfig {
                command_line: "powershell.exe -NoLogo".into(),
                startup_command: "Set-PSReadLineOption -HistorySaveStyle SaveNothing".into(),
                cols: 160,
                rows: 40,
                ..TerminalConfig::default()
            },
        );
        let (tx, rx) = mpsc::channel();
        let handle = spawn_pty(&session, move |bytes| {
            let _ = tx.send(bytes);
            PtyOutputControl::Continue
        })
        .expect("PowerShell ConPTY 시작");
        let mut shell = Self {
            handle,
            rx,
            bytes: Vec::new(),
        };
        shell.until(|s| s.events().iter().any(|e| e.code == 7));
        shell.collect(Duration::from_millis(300));
        shell.bytes.clear();
        shell
    }

    fn events(&self) -> Vec<OscEvent> {
        iter_osc_events(&self.bytes).collect()
    }

    fn phases(&self) -> Vec<(String, String)> {
        self.events()
            .into_iter()
            .filter(|e| e.code == 133)
            .map(|e| (e.param.unwrap_or_default(), e.data))
            .collect()
    }

    fn until(&mut self, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done(self) && Instant::now() < deadline {
            if let Ok(bytes) = self.rx.recv_timeout(Duration::from_millis(50)) {
                self.bytes.extend(bytes);
            }
        }
        assert!(
            done(self),
            "PTY 관측 시간 초과: {:?}",
            String::from_utf8_lossy(&self.bytes)
        );
    }

    fn collect(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            if let Ok(bytes) = self.rx.recv_timeout(Duration::from_millis(20)) {
                self.bytes.extend(bytes);
            }
        }
    }

    fn write(&self, input: &str) {
        self.handle.write(input.as_bytes()).expect("PTY 입력");
    }

    fn command(&mut self, command: &str) -> Vec<(String, String)> {
        self.bytes.clear();
        self.write(command);
        std::thread::sleep(Duration::from_millis(100));
        self.write("\r");
        self.until(|s| s.events().iter().any(|e| e.code == 7));
        self.collect(Duration::from_millis(100));
        self.phases()
    }
}

fn execution(result: &str) -> Vec<(String, String)> {
    vec![("C".into(), "".into()), ("D".into(), result.into())]
}

#[test]
fn powershell_reports_each_execution_before_silent_work_and_its_actual_result() {
    let mut shell = Shell::new();
    assert_eq!(shell.command("Write-Output FIRST_DONE"), execution("0"));
    shell.bytes.clear();
    shell.write("Write-Output SECOND_START; Start-Sleep -Seconds 2; Write-Output SECOND_DONE\r");
    shell.until(|s| {
        s.bytes
            .windows(b"SECOND_START\r\n".len())
            .any(|w| w == b"SECOND_START\r\n")
    });
    assert_eq!(shell.phases(), vec![("C".into(), "".into())]);
    shell.until(|s| s.events().iter().any(|e| e.code == 7));
    assert_eq!(shell.phases(), execution("0"));
    assert_eq!(shell.command("cmd.exe /d /c exit 7"), execution("1"));
    assert_eq!(
        shell.command("Write-Output AFTER_NATIVE_FAILURE"),
        execution("0")
    );
    assert_eq!(
        shell.command("Write-Error EXPECTED_FAILURE"),
        execution("1")
    );
    assert_eq!(
        shell.command("Write-Output AFTER_CMDLET_FAILURE"),
        execution("0")
    );
}

#[test]
fn powershell_editing_does_not_create_tasks_and_interruption_has_no_success() {
    let mut shell = Shell::new();
    assert_eq!(shell.command("Write-Output READY"), execution("0"));
    for input in ["", "   ", "# comment only", "<# block comment #>"] {
        assert!(
            shell.command(input).is_empty(),
            "입력 {input:?}가 작업을 만들면 안 됨"
        );
    }
    shell.bytes.clear();
    shell.write("Write-Output NOT_SUBMITTED");
    shell.collect(Duration::from_millis(200));
    shell.write("\x03");
    shell.until(|s| s.events().iter().any(|e| e.code == 7));
    assert!(shell.phases().is_empty());
    shell.bytes.clear();
    shell.write("& {\r");
    shell.collect(Duration::from_millis(500));
    assert!(shell.phases().is_empty(), "미완성 멀티라인은 시작이 아님");
    shell.write("Write-Output MULTILINE\r}\r");
    shell.until(|s| s.events().iter().any(|e| e.code == 7));
    shell.collect(Duration::from_millis(200));
    assert_eq!(shell.phases(), execution("0"));
    assert_eq!(
        shell.command("& {\rWrite-Output PASTED_ONE\rWrite-Output PASTED_TWO\r}"),
        execution("0")
    );
    shell.bytes.clear();
    shell.write("Start-Sleep -Seconds 30\r");
    shell.until(|s| s.phases().iter().any(|(phase, _)| phase == "C"));
    shell.collect(Duration::from_millis(300));
    shell.write("\x03");
    shell.until(|s| s.events().iter().any(|e| e.code == 7));
    assert_eq!(shell.phases(), execution(""));
}

#[test]
fn powershell_without_psreadline_only_reports_cwd() {
    let (_, args) = TerminalSession::command_line_to_command("powershell.exe");
    let integration = args.last().expect("주입 스크립트");
    let script = format!(
        "Remove-Module PSReadLine -ErrorAction SilentlyContinue\n{integration}\nprompt\nprompt"
    );
    let output = laymux_lib::process::headless_command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .output()
        .expect("PSReadLine 없는 PowerShell");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events: Vec<_> = iter_osc_events(&output.stdout).collect();
    assert_eq!(events.iter().filter(|e| e.code == 7).count(), 2);
    assert!(
        !events.iter().any(|e| e.code == 133),
        "종료만 합성하면 안 됨: {events:?}"
    );
}
