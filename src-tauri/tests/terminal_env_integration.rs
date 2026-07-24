use laymux_lib::pty::spawn_pty;
use laymux_lib::settings::Settings;
use laymux_lib::terminal::{TerminalConfig, TerminalSession};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

fn capability_collision_env() -> Vec<(String, String)> {
    vec![
        ("term_program".into(), "foreign-terminal".into()),
        ("TERM_PROGRAM_VERSION".into(), "foreign-version".into()),
        ("ColOrTeRm".into(), "ansi16".into()),
        ("WT_SESSION".into(), "stale-session".into()),
        ("wt_profile_id".into(), "stale-profile".into()),
        ("TERM".into(), "xterm-custom".into()),
        ("NO_COLOR".into(), "1".into()),
        ("FORCE_COLOR".into(), "2".into()),
    ]
}

fn make_session(profile: &str, command_line: &str, advertise_true_color: bool) -> TerminalSession {
    TerminalSession::new(
        "terminal-env-probe".into(),
        TerminalConfig {
            profile: profile.into(),
            command_line: command_line.into(),
            startup_command: String::new(),
            starting_directory: String::new(),
            cols: 120,
            rows: 40,
            sync_group: "terminal-env-group".into(),
            env: capability_collision_env(),
            advertise_true_color,
        },
    )
}

fn receive_until(rx: &Receiver<Vec<u8>>, marker: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut output = String::new();
    while Instant::now() < deadline {
        if let Ok(data) = rx.recv_timeout(Duration::from_millis(250)) {
            output.push_str(&String::from_utf8_lossy(&data));
            if output.contains(marker) {
                return output;
            }
        }
    }
    panic!("PTY 환경 probe가 제한 시간 안에 marker를 출력하지 못했습니다: {output}");
}

fn expected_capability_marker(prefix: &str, suffix: &str) -> String {
    format!(
        "{prefix}laymux|{}|truecolor|||xterm-custom|1|2{suffix}",
        env!("CARGO_PKG_VERSION")
    )
}

#[test]
fn terminal_truecolor_advertising_defaults_to_enabled() {
    assert!(Settings::default().terminal.advertise_true_color);

    let settings: Settings = serde_json::from_value(serde_json::json!({
        "terminal": { "copyOnSelect": false }
    }))
    .expect("missing advertiseTrueColor setting should deserialize");
    assert!(settings.terminal.advertise_true_color);
}

#[cfg(windows)]
#[test]
fn native_windows_child_receives_laymux_capability_contract() {
    let session = make_session("PowerShell", "powershell.exe -NoLogo", true);
    let (tx, rx) = mpsc::channel();
    let handle = spawn_pty(&session, move |data| {
        let _ = tx.send(data);
    })
    .expect("PowerShell PTY spawn");

    handle
        .write(
            b"$v=@($env:TERM_PROGRAM,$env:TERM_PROGRAM_VERSION,$env:COLORTERM,$env:WT_SESSION,$env:WT_PROFILE_ID,$env:TERM,$env:NO_COLOR,$env:FORCE_COLOR); Write-Output ('__LAYMUX_ENV__'+($v -join '|')+'__')\r\n",
        )
        .expect("PowerShell 환경 probe write");

    let marker = expected_capability_marker("__LAYMUX_ENV__", "__");
    let output = receive_until(&rx, &marker);
    assert!(
        output.contains(&marker),
        "native 환경 계약 불일치: {output}"
    );

    let _ = handle.write(b"exit\r\n");
}

#[cfg(windows)]
#[test]
fn native_windows_child_can_disable_truecolor_advertising() {
    let session = make_session("PowerShell", "powershell.exe -NoLogo", false);
    let (tx, rx) = mpsc::channel();
    let handle = spawn_pty(&session, move |data| {
        let _ = tx.send(data);
    })
    .expect("PowerShell PTY spawn");

    handle
        .write(
            b"$v=@($env:TERM_PROGRAM,$env:TERM_PROGRAM_VERSION,$env:COLORTERM,$env:WT_SESSION,$env:WT_PROFILE_ID,$env:TERM,$env:NO_COLOR,$env:FORCE_COLOR); Write-Output ('__LAYMUX_ENV_OFF__'+($v -join '|')+'__')\r\n",
        )
        .expect("PowerShell 환경 probe write");

    let marker = format!(
        "__LAYMUX_ENV_OFF__laymux|{}||||xterm-custom|1|2__",
        env!("CARGO_PKG_VERSION")
    );
    let output = receive_until(&rx, &marker);
    assert!(
        output.contains(&marker),
        "native opt-out 계약 불일치: {output}"
    );

    let _ = handle.write(b"exit\r\n");
}

#[cfg(unix)]
#[test]
fn native_unix_child_receives_laymux_capability_contract() {
    let session = make_session("sh", "/bin/sh", true);
    let (tx, rx) = mpsc::channel();
    let handle = spawn_pty(&session, move |data| {
        let _ = tx.send(data);
    })
    .expect("Unix PTY spawn");

    handle
        .write(
            b"printf '__LAYMUX_ENV__%s|%s|%s|%s|%s|%s|%s|%s__\\n' \"$TERM_PROGRAM\" \"$TERM_PROGRAM_VERSION\" \"$COLORTERM\" \"$WT_SESSION\" \"$WT_PROFILE_ID\" \"$TERM\" \"$NO_COLOR\" \"$FORCE_COLOR\"; exit\n",
        )
        .expect("Unix 환경 probe write");

    let marker = expected_capability_marker("__LAYMUX_ENV__", "__");
    let output = receive_until(&rx, &marker);
    assert!(
        output.contains(&marker),
        "native 환경 계약 불일치: {output}"
    );
}

#[cfg(windows)]
fn wsl_available() -> bool {
    laymux_lib::process::headless_command("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

#[cfg(windows)]
#[test]
fn wsl_child_receives_mutations_without_stale_windows_terminal_identity() {
    if !wsl_available() {
        eprintln!("WSL 배포판이 없어 실제 WSL child probe를 건너뜁니다.");
        return;
    }

    let mut session = make_session("WSL", "wsl.exe", true);
    session.config.env.push((
        "WSLENV".into(),
        "KEEP/u:wt_session/p:WT_PROFILE_ID:KeepTwo/l:WT_SESSION:KEEP/u".into(),
    ));
    let (tx, rx) = mpsc::channel();
    let handle = spawn_pty(&session, move |data| {
        let _ = tx.send(data);
    })
    .expect("WSL PTY spawn");

    handle
        .write(
            b"printf '__LAYMUX_WSL_ENV__%s|%s|%s|%s|%s|%s|%s|%s__WSLENV__%s__\\n' \"$TERM_PROGRAM\" \"$TERM_PROGRAM_VERSION\" \"$COLORTERM\" \"$WT_SESSION\" \"$WT_PROFILE_ID\" \"$TERM\" \"$NO_COLOR\" \"$FORCE_COLOR\" \"$WSLENV\"; exit\n",
        )
        .expect("WSL 환경 probe write");

    let marker = format!(
        "{}WSLENV__KEEP/u:KeepTwo/l:KEEP/u__",
        expected_capability_marker("__LAYMUX_WSL_ENV__", "__")
    );
    let output = receive_until(&rx, &marker);
    assert!(output.contains(&marker), "WSL 환경 계약 불일치: {output}");
}

#[cfg(windows)]
#[test]
fn wsl_child_can_disable_truecolor_advertising() {
    if !wsl_available() {
        eprintln!("WSL 배포판이 없어 실제 WSL child opt-out probe를 건너뜁니다.");
        return;
    }

    let mut session = make_session("WSL", "wsl.exe", false);
    session.config.env.push((
        "WSLENV".into(),
        "KEEP/u:wt_session/p:WT_PROFILE_ID:KeepTwo/l:WT_SESSION:KEEP/u".into(),
    ));
    let (tx, rx) = mpsc::channel();
    let handle = spawn_pty(&session, move |data| {
        let _ = tx.send(data);
    })
    .expect("WSL PTY spawn");

    handle
        .write(
            b"printf '__LAYMUX_WSL_ENV_OFF__%s|%s|%s|%s|%s|%s|%s|%s__WSLENV__%s__\\n' \"$TERM_PROGRAM\" \"$TERM_PROGRAM_VERSION\" \"$COLORTERM\" \"$WT_SESSION\" \"$WT_PROFILE_ID\" \"$TERM\" \"$NO_COLOR\" \"$FORCE_COLOR\" \"$WSLENV\"; exit\n",
        )
        .expect("WSL 환경 opt-out probe write");

    let marker = format!(
        "__LAYMUX_WSL_ENV_OFF__laymux|{}||||xterm-custom|1|2__WSLENV__KEEP/u:KeepTwo/l:KEEP/u__",
        env!("CARGO_PKG_VERSION")
    );
    let output = receive_until(&rx, &marker);
    assert!(
        output.contains(&marker),
        "WSL opt-out 계약 불일치: {output}"
    );
}
