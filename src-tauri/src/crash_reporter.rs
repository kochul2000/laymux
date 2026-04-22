//! 패닉 훅으로 크래시를 잡아서 파일 기록 + 네이티브 다이얼로그로 표시한다.
//!
//! 동작:
//! 1. 패닉 발생 → `PanicHookInfo` + `Backtrace`를 캡처
//! 2. 설정 디렉터리의 `crash.log`에 append (항상 수행)
//! 3. `rfd::MessageDialog`로 플랫폼 네이티브 알림창 시도
//!    (Windows TaskDialog / macOS NSAlert / Linux zenity·kdialog)
//! 4. 다이얼로그 호출이 실패/panic하면 stderr로 fallback 출력
//!
//! 여러 스레드가 동시에 패닉해도 다이얼로그는 최초 1회만 표시한다
//! (이후 스레드는 `crash.log` append만 한다).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::panic::{self, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const CRASH_LOG_FILENAME: &str = "crash.log";

/// 캡처한 크래시 정보.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    /// Unix epoch seconds (UTC). 0이면 시스템 시간 조회 실패.
    pub timestamp_unix: u64,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub thread: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<CrashLocation>,
    pub backtrace: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLocation {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

impl CrashReport {
    pub fn from_panic(info: &PanicHookInfo<'_>, backtrace: String) -> Self {
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };

        let location = info.location().map(|loc| CrashLocation {
            file: loc.file().to_string(),
            line: loc.line(),
            column: loc.column(),
        });

        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();

        let timestamp_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        Self {
            timestamp_unix,
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            thread,
            message,
            location,
            backtrace,
        }
    }

    /// 복사-붙여넣기 본문.
    pub fn to_plain_text(&self) -> String {
        let location = self
            .location
            .as_ref()
            .map(|l| format!("{}:{}:{}", l.file, l.line, l.column))
            .unwrap_or_else(|| "<unknown>".to_string());
        format!(
            "laymux {} crash (unix={}, {}/{}, thread={})\n\
             location: {}\n\
             message: {}\n\
             backtrace:\n{}\n",
            self.version,
            self.timestamp_unix,
            self.os,
            self.arch,
            self.thread,
            location,
            self.message,
            self.backtrace
        )
    }
}

/// 프로세스 전역에 패닉 훅을 설치한다. 여러 번 호출돼도 한 번만 설정된다.
///
/// `dir`이 `Some`이면 패닉 시 `dir/crash.log`에 append한다.
/// `None`이면 파일 기록을 건너뛴다(테스트/임베디드 용도).
///
/// 주의: 테스트 빌드(`cfg(test)`)에서는 훅을 설치하지 않는다. 의도적으로 panic을
/// 일으키는 테스트(예: mutex poison 검증)가 있을 때 매번 네이티브 크래시
/// 다이얼로그가 뜨는 것을 막기 위함이다.
pub fn install(dir: Option<PathBuf>) {
    #[cfg(test)]
    {
        let _ = dir;
    }

    #[cfg(not(test))]
    {
        use std::backtrace::Backtrace;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Once;

        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let default_hook = panic::take_hook();
            panic::set_hook(Box::new(move |info| {
                let backtrace = Backtrace::force_capture().to_string();
                let report = CrashReport::from_panic(info, backtrace);

                if let Some(dir) = dir.as_ref() {
                    if let Err(e) = append_log(dir, &report) {
                        // 훅 안에서 또 패닉하면 안 되므로 tracing도 피하고 stderr로만 남긴다.
                        eprintln!("[crash_reporter] failed to append crash.log: {e}");
                    }
                }

                // 여러 스레드가 동시 패닉해도 다이얼로그는 1회만 띄운다.
                static DIALOG_SHOWN: AtomicBool = AtomicBool::new(false);
                if !DIALOG_SHOWN.swap(true, Ordering::SeqCst) {
                    show_crash_dialog(&report);
                }

                default_hook(info);
            }));
        });
    }
}

fn append_log(dir: &Path, report: &CrashReport) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    let log_path = dir.join(CRASH_LOG_FILENAME);
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    writeln!(
        f,
        "--- {} laymux {} ({}/{}) thread={} ---",
        report.timestamp_unix, report.version, report.os, report.arch, report.thread
    )?;
    f.write_all(report.to_plain_text().as_bytes())?;
    writeln!(f)?;
    Ok(())
}

/// 다이얼로그에 표시할 본문. `MessageBox`가 세로로 너무 길어지지 않도록 백트레이스를
/// 앞 N프레임만 보여주고, 전체는 `crash.log`에서 확인하도록 안내한다.
fn dialog_body(report: &CrashReport, log_path: Option<&Path>) -> String {
    const MAX_BT_LINES: usize = 40;
    let bt: Vec<&str> = report.backtrace.lines().collect();
    let (bt_shown, truncated) = if bt.len() > MAX_BT_LINES {
        (bt[..MAX_BT_LINES].join("\n"), bt.len() - MAX_BT_LINES)
    } else {
        (bt.join("\n"), 0)
    };

    let location = report
        .location
        .as_ref()
        .map(|l| format!("{}:{}:{}", l.file, l.line, l.column))
        .unwrap_or_else(|| "<unknown>".to_string());

    let mut body = format!(
        "laymux {} ({}/{}) — thread: {}\n\
         시각(unix): {}\n\
         위치: {}\n\n\
         메시지:\n{}\n\n\
         backtrace:\n{}",
        report.version,
        report.os,
        report.arch,
        report.thread,
        report.timestamp_unix,
        location,
        report.message,
        bt_shown
    );
    if truncated > 0 {
        body.push_str(&format!("\n... ({truncated}개 프레임 생략)"));
    }
    if let Some(p) = log_path {
        body.push_str(&format!("\n\n전체 내용: {}", p.display()));
    }
    body.push_str("\n\nCtrl+C 를 누르면 이 창의 내용이 클립보드에 복사됩니다.");
    body
}

#[cfg(not(test))]
fn show_crash_dialog(report: &CrashReport) {
    let log_path = crate::settings::dirs_config_path().map(|d| d.join(CRASH_LOG_FILENAME));
    let body = dialog_body(report, log_path.as_deref());
    let caption = format!("Laymux {} 크래시", report.version);

    // rfd는 Linux에서 zenity/kdialog를 찾지 못하면 panic할 수 있고, macOS는 non-main
    // 스레드에서 NSAlert 호출 시 문제될 수 있다. panic 상태 위에서 추가 panic이 나면
    // 프로세스가 바로 abort되므로 catch_unwind로 격리해서 실패 시 stderr로 fallback한다.
    let show_result = {
        let body = body.clone();
        let caption = caption.clone();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            rfd::MessageDialog::new()
                .set_title(&caption)
                .set_description(&body)
                .set_level(rfd::MessageLevel::Error)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        }))
    };

    if show_result.is_err() {
        eprintln!(
            "\n======== {caption} (native dialog 실패, stderr fallback) ========\n\
             {body}\n\
             =================================================================\n"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn sample_report() -> CrashReport {
        CrashReport {
            timestamp_unix: 1_700_000_000,
            version: "0.3.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            thread: "main".into(),
            message: "assertion failed".into(),
            location: Some(CrashLocation {
                file: "src/foo.rs".into(),
                line: 42,
                column: 7,
            }),
            backtrace: "  0: foo\n  1: bar".into(),
        }
    }

    #[test]
    fn serialize_round_trip() {
        let report = sample_report();
        let json = serde_json::to_string(&report).unwrap();
        let parsed: CrashReport = serde_json::from_str(&json).unwrap();
        assert_eq!(report, parsed);
    }

    #[test]
    fn serialize_uses_camel_case() {
        let report = sample_report();
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"timestampUnix\":1700000000"), "json={json}");
        assert!(!json.contains("timestamp_unix"));
    }

    #[test]
    fn location_is_skipped_when_none() {
        let mut report = sample_report();
        report.location = None;
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("location"));
    }

    #[test]
    fn plain_text_contains_key_fields() {
        let text = sample_report().to_plain_text();
        assert!(text.contains("assertion failed"));
        assert!(text.contains("src/foo.rs:42:7"));
        assert!(text.contains("0.3.0"));
    }

    #[test]
    fn plain_text_uses_unknown_when_location_missing() {
        let mut report = sample_report();
        report.location = None;
        let text = report.to_plain_text();
        assert!(text.contains("<unknown>"));
    }

    #[test]
    fn append_log_creates_file_and_appends() {
        let dir = tempdir().unwrap();
        let mut first = sample_report();
        first.message = "first panic".into();
        first.timestamp_unix = 1;
        let mut second = sample_report();
        second.message = "second panic".into();
        second.timestamp_unix = 2;

        append_log(dir.path(), &first).unwrap();
        append_log(dir.path(), &second).unwrap();

        let log = fs::read_to_string(dir.path().join(CRASH_LOG_FILENAME)).unwrap();
        assert!(log.contains("first panic"));
        assert!(log.contains("second panic"));
        // 두 번째 레코드가 첫 번째 뒤에 와야 한다(append 순서 보장).
        assert!(log.find("first panic").unwrap() < log.find("second panic").unwrap());
    }

    #[test]
    fn append_log_creates_dir_if_missing() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        assert!(!nested.exists());
        append_log(&nested, &sample_report()).unwrap();
        assert!(nested.join(CRASH_LOG_FILENAME).exists());
    }

    #[test]
    fn dialog_body_includes_message_location_and_copy_hint() {
        let body = dialog_body(&sample_report(), None);
        assert!(body.contains("assertion failed"));
        assert!(body.contains("src/foo.rs:42:7"));
        assert!(body.contains("Ctrl+C"));
        // 로그 경로를 주지 않으면 "전체 내용:" 줄이 없다.
        assert!(!body.contains("전체 내용:"));
    }

    #[test]
    fn dialog_body_includes_log_path_when_given() {
        let p = PathBuf::from("C:/tmp/crash.log");
        let body = dialog_body(&sample_report(), Some(&p));
        assert!(body.contains("C:/tmp/crash.log"));
    }

    #[test]
    fn dialog_body_truncates_long_backtrace() {
        let mut report = sample_report();
        let long: Vec<String> = (0..100).map(|i| format!("  {i}: frame {i}")).collect();
        report.backtrace = long.join("\n");
        let body = dialog_body(&report, None);
        assert!(body.contains("프레임 생략"));
        // 생략 전 40개는 유지.
        assert!(body.contains("  0: frame 0"));
        assert!(body.contains("  39: frame 39"));
        // 40번째 이후는 제외되어야 한다.
        assert!(!body.contains("  40: frame 40"));
    }

    #[test]
    fn dialog_body_does_not_truncate_short_backtrace() {
        let body = dialog_body(&sample_report(), None);
        assert!(!body.contains("프레임 생략"));
    }

    #[test]
    #[serial_test::serial]
    fn panic_hook_captures_message_location_and_backtrace() {
        use std::sync::{Arc, Mutex};
        let captured: Arc<Mutex<Option<CrashReport>>> = Arc::new(Mutex::new(None));
        let sink = captured.clone();

        let prev = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let report = CrashReport::from_panic(info, "fake-bt".into());
            *sink.lock().unwrap() = Some(report);
        }));
        let result = panic::catch_unwind(|| panic!("hello from test"));
        panic::set_hook(prev);
        assert!(result.is_err());

        let report = captured.lock().unwrap().clone().unwrap();
        assert_eq!(report.message, "hello from test");
        assert_eq!(report.backtrace, "fake-bt");
        let loc = report.location.expect("location captured");
        assert!(loc.file.ends_with("crash_reporter.rs"));
        assert!(loc.line > 0);
    }

    #[test]
    fn install_is_idempotent_without_dir() {
        install(None);
        install(None);
    }

    /// 테스트 빌드에서 `install()`은 반드시 no-op 이어야 한다.
    /// 그렇지 않으면 의도적으로 panic을 일으키는 테스트(예: `lock_ext::tests::
    /// lock_or_err_returns_app_error_on_poison`)가 실행될 때마다 네이티브
    /// 크래시 다이얼로그가 떠서 CI/개발 워크플로를 망가뜨린다.
    ///
    /// sentinel 훅을 설치한 뒤 `install()`을 호출하고, 이후 probe panic 시
    /// sentinel이 호출되는지로 훅 교체 여부를 검증한다. panic hook은 프로세스
    /// 전역이라 병렬 실행되는 다른 테스트의 panic도 sentinel을 트리거하므로,
    /// probe 메시지로 필터링해 우리 panic 만 카운트한다.
    #[test]
    #[serial_test::serial]
    fn install_does_not_replace_panic_hook_in_test_mode() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tempfile::tempdir;

        const PROBE_TAG: &str = "crash_reporter::install sentinel probe";
        let counter = Arc::new(AtomicUsize::new(0));
        let sentinel = counter.clone();

        let prev = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let msg = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("");
            if msg.contains(PROBE_TAG) {
                sentinel.fetch_add(1, Ordering::SeqCst);
            }
        }));

        let dir = tempdir().unwrap();
        install(None);
        install(Some(dir.path().to_path_buf()));

        let _ = panic::catch_unwind(|| {
            panic!("{PROBE_TAG} 1");
        });
        let _ = panic::catch_unwind(|| {
            panic!("{PROBE_TAG} 2");
        });

        panic::set_hook(prev);

        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "install() 이 테스트 빌드에서 panic 훅을 교체했다 — 의도적 panic 테스트에서 크래시 다이얼로그가 발생한다"
        );
        assert!(
            !dir.path().join(CRASH_LOG_FILENAME).exists(),
            "install() 이 테스트 빌드에서 crash.log 를 기록했다"
        );
    }
}
