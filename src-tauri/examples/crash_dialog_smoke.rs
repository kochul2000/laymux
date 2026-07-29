//! 수동 smoke test: panic hook + 네이티브 크래시 다이얼로그 확인용.
//!
//! Windows에서는 native message box가, Linux에서는 GTK3 message dialog가 뜬다.
//! OK를 누르면 프로세스가 종료된다. `crash.log`는 OS 임시 디렉터리 아래
//! `laymux-crash-smoke`에 쌓인다.
//!
//! ```powershell
//! cargo run --example crash_dialog_smoke
//! ```
//!
//! 대화상자를 열 수 없는 headless Linux에서는 compile seam만 확인한다.
//!
//! ```bash
//! cargo check --locked --example crash_dialog_smoke
//! ```

fn main() {
    let dir = std::env::temp_dir().join("laymux-crash-smoke");
    println!("crash.log dir: {}", dir.display());
    laymux_lib::crash_reporter::install(Some(dir));
    panic!("crash dialog smoke test — 이 문자열이 다이얼로그에 보여야 합니다.");
}
