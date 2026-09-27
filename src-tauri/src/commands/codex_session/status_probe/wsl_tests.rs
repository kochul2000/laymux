use super::targets;
use crate::session_checkpoint::codex_status::CodexStatusProcess;
use std::path::PathBuf;
use std::time::Duration;

const DISTRO: &str = "Ubuntu-22.04";
const ID: &str = "01a0e103-7bcb-7a20-89c0-2dc0472f2957";

struct Fixture(String);

impl Drop for Fixture {
    fn drop(&mut self) {
        let mut command = crate::process::headless_command("wsl.exe");
        command.args([
            "-d",
            DISTRO,
            "--exec",
            "sh",
            "-c",
            "case \"$1\" in /tmp/laymux-codex-rollout-test.*) rm -rf -- \"$1\";; *) exit 1;; esac",
            "cleanup",
            &self.0,
        ]);
        let _ = crate::process::output_with_timeout(&mut command, Duration::from_secs(3));
    }
}

#[test]
#[ignore = "requires Ubuntu-22.04 WSL; run with --ignored"]
fn wsl_rollout_symlinks_never_turn_persisted_sessions_into_fresh() {
    const SETUP: &str = r#"
set -eu
root=$(mktemp -d /tmp/laymux-codex-rollout-test.XXXXXX)
trap 'case "$root" in /tmp/laymux-codex-rollout-test.*) rm -rf -- "$root";; esac' EXIT
mkdir -p "$root/plain/sessions/2026/09/27" "$root/missing" "$root/empty/sessions"
file="rollout-$1.jsonl"
printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/project","source":"cli"}}\n' "$1" > "$root/plain/sessions/2026/09/27/$file"
ln -s "$root/plain" "$root/home-link"
mkdir -p "$root/root-link" "$root/date-link/sessions" "$root/file-link/sessions/2026/09/27" "$root/broken-link" "$root/loop"
ln -s "$root/plain/sessions" "$root/root-link/sessions"
ln -s "$root/plain/sessions/2026" "$root/date-link/sessions/2026"
ln -s "$root/plain/sessions/2026/09/27/$file" "$root/file-link/sessions/2026/09/27/$file"
ln -s "$root/absent" "$root/broken-link/sessions"
ln -s sessions "$root/loop/sessions"
printf '%s\n' "$root"
trap - EXIT
"#;
    let mut command = crate::process::headless_command("wsl.exe");
    command.args(["-d", DISTRO, "--exec", "sh", "-c", SETUP, "fixture", ID]);
    let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(5)).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let root = Fixture(String::from_utf8(output.stdout).unwrap().trim().to_owned());
    assert!(root.0.starts_with("/tmp/laymux-codex-rollout-test."));
    for mode in [
        "missing",
        "empty",
        "plain",
        "home-link",
        "root-link",
        "date-link",
        "file-link",
        "broken-link",
        "loop",
    ] {
        let codex_home = PathBuf::from(format!("//wsl.localhost/{DISTRO}{}/{mode}", root.0));
        let process = CodexStatusProcess {
            pid: 1,
            started_at: 1,
            distro: Some(DISTRO.into()),
            sqlite_home: codex_home.clone(),
            codex_home,
        };
        let result = targets::verify_session(&process, ID);
        match mode {
            "missing" | "empty" => assert_eq!(result, Ok(true), "{mode}"),
            "plain" => assert_eq!(result, Ok(false), "{mode}"),
            _ => assert!(
                !matches!(result, Ok(true)),
                "{mode}: must preserve the restore ID"
            ),
        }
    }
}
