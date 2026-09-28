use super::*;
use std::os::windows::process::ExitStatusExt;

fn output(code: u32, stdout: &[u8], stderr: &[u8]) -> std::process::Output {
    std::process::Output {
        status: std::process::ExitStatus::from_raw(code),
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

#[test]
fn failed_guest_read_reports_target_stage_path_and_stderr_without_configuration_contents() {
    let stderr = b"wc: Permission denied\nLAYMUX_CODEX_CONFIG_ERROR_V1\0config.size\0/tmp/project/config.toml\0";
    let error = read_config_result(
        "Ubuntu-22.04",
        42,
        Ok(output(
            1,
            b"LAYMUX_CODEX_CONFIG_V1\nCSECRET_CONFIG_CONTENTS",
            stderr,
        )),
    )
    .unwrap_err();
    for expected in [
        "distro=Ubuntu-22.04",
        "pid=42",
        "stage=config.size",
        "path=/tmp/project/config.toml",
        "could not read configuration file size",
        "exit code: 1",
        "stderr=wc: Permission denied",
    ] {
        assert!(error.contains(expected), "{error}");
    }
    assert!(!error.contains("SECRET_CONFIG_CONTENTS"));
    assert!(!error.contains("LAYMUX_CODEX_CONFIG_ERROR_V1"));
}

#[test]
fn guest_paths_with_unicode_newlines_and_controls_remain_bounded_and_readable() {
    let stderr = format!(
        "LAYMUX_CODEX_CONFIG_ERROR_V1\0config.symlink\0/tmp/한글\n\u{1b}/config.toml{}\0",
        "x".repeat(1024)
    );
    let error = read_config_result("Ubuntu", 7, Ok(output(1, b"", stderr.as_bytes()))).unwrap_err();
    assert!(
        error.contains("path=/tmp/한글\\n\\u{1b}/config.toml"),
        "{error}"
    );
    assert!(error.contains('…'));
    assert!(!error.contains('\n'));
    assert!(!error.contains('\u{1b}'));
    assert!(error.len() < 1024);
}

#[test]
fn unframed_or_malformed_guest_failures_keep_exit_context_and_bounded_stderr() {
    for stderr in [
        b"WSL launcher failed".as_slice(),
        b"LAYMUX_CODEX_CONFIG_ERROR_V1\0config.size\0/truncated",
        b"LAYMUX_CODEX_CONFIG_ERROR_V1\0unknown.stage\0/config.toml\0",
        &vec![b'x'; 4096],
    ] {
        let error = read_config_result("Ubuntu", 7, Ok(output(27, b"SECRET", stderr))).unwrap_err();
        assert!(error.contains("stage=process.exit"), "{error}");
        assert!(error.contains("exit code: 27"), "{error}");
        assert!(error.contains("stderr="), "{error}");
        assert!(!error.contains("SECRET"));
        assert!(!error.contains('\0'));
        assert!(error.len() < 1024);
    }
}

#[test]
fn launch_and_timeout_errors_identify_the_target_and_failure_stage() {
    for (kind, stage, cause) in [
        (
            std::io::ErrorKind::NotFound,
            "process.execute",
            "wsl.exe missing",
        ),
        (
            std::io::ErrorKind::TimedOut,
            "process.timeout",
            "process timed out after 3s",
        ),
    ] {
        let error =
            read_config_result("Ubuntu", 42, Err(std::io::Error::new(kind, cause))).unwrap_err();
        for expected in ["distro=Ubuntu", "pid=42", stage, cause] {
            assert!(error.contains(expected), "{error}");
        }
    }
}

#[test]
fn malformed_responses_identify_the_failed_parse_step_without_exposing_records() {
    for (bytes, reason) in [
        (
            b"SECRET_CONFIG_CONTENTS".as_slice(),
            "header is missing or invalid",
        ),
        (
            b"LAYMUX_CODEX_CONFIG_V1\nCSECRET_CONFIG_CONTENTS",
            "missing END marker",
        ),
        (
            b"LAYMUX_CODEX_CONFIG_V1\nSECRET_CONFIG_CONTENTS\nEND\n",
            "record 1 has an invalid prefix",
        ),
        (
            b"LAYMUX_CODEX_CONFIG_V1\nCSECRET_CONFIG_CONTENTS\nEND\n",
            "record 1 contains invalid base64",
        ),
        (
            b"LAYMUX_CODEX_CONFIG_V1\nC/w==\nEND\n",
            "record 1 is not valid UTF-8",
        ),
        (b"\xffSECRET_CONFIG_CONTENTS", "response is not valid UTF-8"),
        (
            &vec![b'x'; CONFIG_RESPONSE_LIMIT + 1],
            "exceeds the 2097152-byte limit",
        ),
    ] {
        let error = read_config_result("Ubuntu", 42, Ok(output(0, bytes, b""))).unwrap_err();
        assert!(error.contains("stage=response.parse"), "{error}");
        assert!(error.contains(reason), "{error}");
        assert!(!error.contains("SECRET_CONFIG_CONTENTS"));
    }
}

#[test]
fn invalid_guest_input_identifies_the_path_before_launching_wsl() {
    let error = read_editor_configs("Ubuntu", 42, Path::new("relative/home"), Path::new("/tmp"))
        .unwrap_err();
    assert!(
        error.contains("stage=input.path; codexHome=relative/home"),
        "{error}"
    );
    let error = read_editor_configs(
        "Ubuntu",
        42,
        Path::new("/home/test"),
        Path::new("relative/cwd"),
    )
    .unwrap_err();
    assert!(
        error.contains("stage=input.path; terminalCwd=relative/cwd"),
        "{error}"
    );
    let error = read_editor_configs(
        "invalid\ndistro",
        42,
        Path::new("/home/test"),
        Path::new("/tmp"),
    )
    .unwrap_err();
    assert!(error.contains("stage=input.distro"), "{error}");
}

#[test]
#[ignore = "requires Ubuntu-22.04 WSL; run with --ignored"]
fn wsl_missing_process_error_identifies_the_failed_step_and_target() {
    let error = read_editor_configs(
        "Ubuntu-22.04",
        u32::MAX,
        Path::new("/tmp/laymux-config-diagnostic-home"),
        Path::new("/tmp"),
    )
    .unwrap_err();
    assert!(error.contains("process.directory"), "{error}");
    assert!(error.contains("Ubuntu-22.04"), "{error}");
    assert!(error.contains("pid=4294967295"), "{error}");
    assert!(error.contains("/proc/4294967295"), "{error}");
}

#[test]
#[ignore = "requires Ubuntu-22.04 WSL; run with --ignored"]
fn wsl_regular_file_config_parent_is_absent_and_other_configs_are_still_inspected() {
    const FIXTURE: &str = r#"
set -eu
root=$(mktemp -d /tmp/laymux-codex-config-test.XXXXXX)
trap 'case "$root" in /tmp/laymux-codex-config-test.*) rm -rf -- "$root";; esac' EXIT
mkdir -p "$root/work/nested" "$root/reported" "$root/home" "$root/.codex"
printf 'model = "fixture-home"\n' > "$root/home/config.toml"
printf "[tui.keymap.composer]\nsubmit = 'ctrl-u'\n" > "$root/.codex/config.toml"
case "$2" in
  actual-file) marker="$root/work/nested/.codex" ;;
  ancestor-file) marker="$root/work/.codex" ;;
  reported-file) marker="$root/reported/.codex" ;;
  file-link)
    marker="$root/marker"
    ln -s "$marker" "$root/work/nested/.codex"
    ;;
esac
touch "$marker"
chmod 444 "$marker"
cd "$root/work/nested"
sh -c "$1" probe "$$" "$root/home" "$root/reported"
"#;
    for mode in ["actual-file", "ancestor-file", "reported-file", "file-link"] {
        let mut command = crate::process::headless_command("wsl.exe");
        command.args([
            "-d",
            "Ubuntu-22.04",
            "--exec",
            "sh",
            "-c",
            FIXTURE,
            "fixture",
            EDITOR_CONFIG_SCRIPT,
            mode,
        ]);
        let result = crate::process::output_with_timeout(&mut command, Duration::from_secs(5));
        let configs = read_config_result("Ubuntu-22.04", 42, result)
            .unwrap_or_else(|error| panic!("{mode}: {error}"));
        assert!(
            configs.iter().any(|text| text.contains("fixture-home")),
            "{mode}: {configs:?}"
        );
        assert!(
            configs
                .iter()
                .any(|text| text.contains("submit = 'ctrl-u'")),
            "{mode}: {configs:?}"
        );
    }
}

#[test]
#[ignore = "requires non-root Ubuntu-22.04 WSL; run with --ignored"]
fn wsl_guest_failures_identify_the_actual_guard_and_affected_path() {
    const FIXTURE: &str = r#"
set -eu
[ "$(id -u)" != 0 ] || { printf 'fixture requires a non-root WSL user' >&2; exit 2; }
root=$(mktemp -d /tmp/laymux-codex-config-test.XXXXXX)
trap 'case "$root" in /tmp/laymux-codex-config-test.*) chmod -R u+rwX -- "$root"; rm -rf -- "$root";; esac' EXIT
mkdir -p "$root/A/.codex" "$root/B/.codex" "$root/home" "$root/bin"
case "$2" in
  config.symlink) ln -s "$root/missing" "$root/home/config.toml" ;;
  config.type) mkdir "$root/home/config.toml" ;;
  config.readable) touch "$root/home/config.toml"; chmod 000 "$root/home/config.toml" ;;
  config.parent) chmod 000 "$root/home" ;;
  parent-link) rmdir "$root/home"; ln -s "$root/missing" "$root/home" ;;
  config.file_limit) truncate -s 262145 "$root/home/config.toml" ;;
  config.total_limit)
    mkdir "$root/.codex"
    for file in "$root/home/config.toml" "$root/home/managed_config.toml" "$root/B/.codex/config.toml" "$root/.codex/config.toml"; do
      truncate -s 262144 "$file"
    done
    printf x > "$root/A/.codex/config.toml"
    ;;
  config.size|config.encode)
    printf 'SECRET_CONFIG_CONTENTS' > "$root/home/config.toml"
    case "$2" in config.size) tool=wc;; *) tool=base64;; esac
    printf '#!/bin/sh\nprintf "fixture tool denied\\n" >&2\nexit 13\n' > "$root/bin/$tool"
    chmod +x "$root/bin/$tool"
    PATH="$root/bin:$PATH"
    export PATH
    ;;
  cwd.resolve) ;;
esac
cd "$root/B"
if [ "$2" = cwd.resolve ]; then rmdir "$root/B/.codex" "$root/B"; fi
sh -c "$1" probe "$$" "$root/home" "$root/A"
"#;
    for (mode, path) in [
        ("config.symlink", "/home/config.toml"),
        ("config.type", "/home/config.toml"),
        ("config.readable", "/home/config.toml"),
        ("config.parent", "/home"),
        ("parent-link", "/home"),
        ("config.file_limit", "/home/config.toml"),
        ("config.total_limit", "/A/.codex/config.toml"),
        ("config.size", "/home/config.toml"),
        ("config.encode", "/home/config.toml"),
        ("cwd.resolve", "/cwd"),
    ] {
        let mut command = crate::process::headless_command("wsl.exe");
        command.args([
            "-d",
            "Ubuntu-22.04",
            "--exec",
            "sh",
            "-c",
            FIXTURE,
            "fixture",
            EDITOR_CONFIG_SCRIPT,
            mode,
        ]);
        let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(5));
        let error = read_config_result("Ubuntu-22.04", 42, output).unwrap_err();
        let stage = if mode == "parent-link" {
            "config.parent"
        } else {
            mode
        };
        assert!(
            error.contains(&format!("stage={stage}; path=")),
            "{mode}: {error}"
        );
        assert!(error.contains(path), "{mode}: {error}");
        assert!(!error.contains("SECRET_CONFIG_CONTENTS"), "{mode}: {error}");
        if matches!(mode, "config.size" | "config.encode") {
            assert!(error.contains("fixture tool denied"), "{mode}: {error}");
        }
    }
}

#[test]
fn guest_config_output_requires_a_complete_frame_and_valid_encoding() {
    assert!(parse_configs(b"LAYMUX_CODEX_CONFIG_V1\nEND\n")
        .unwrap()
        .is_empty());
    let text = "[tui.keymap.composer]\nsubmit = 'ctrl-u'";
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text);
    let frame = format!("LAYMUX_CODEX_CONFIG_V1\nC{encoded}\nEND\n");
    assert_eq!(parse_configs(frame.as_bytes()).unwrap(), vec![text]);
    for malformed in [
        "",
        "END\n",
        "LAYMUX_CODEX_CONFIG_V1\n",
        "LAYMUX_CODEX_CONFIG_V1\nC?\nEND\n",
    ] {
        assert!(parse_configs(malformed.as_bytes()).is_err());
    }
}

// Run explicitly on the Windows development host; never require a distro in CI.
#[test]
#[ignore = "requires Ubuntu-22.04 WSL; run with --ignored"]
fn wsl_actual_cwd_and_symlinked_configs_are_inspected_before_input() {
    const FIXTURE: &str = r#"
set -eu
root=$(mktemp -d /tmp/laymux-codex-config-test.XXXXXX)
trap 'case "$root" in /tmp/laymux-codex-config-test.*) rm -rf -- "$root";; esac' EXIT
mkdir -p "$root/A" "$root/B/.codex" "$root/home" "$root/dotfiles"
printf "[tui.keymap.composer]\nsubmit = 'ctrl-u'\n" > "$root/dotfiles/config.toml"
case "$2" in
  cwd) cp "$root/dotfiles/config.toml" "$root/B/.codex/config.toml" ;;
  file-link) ln -s "$root/dotfiles/config.toml" "$root/home/config.toml" ;;
  directory-link) rmdir "$root/B/.codex"; ln -s "$root/dotfiles" "$root/B/.codex" ;;
  broken-link) ln -s "$root/missing" "$root/home/config.toml" ;;
  missing) ;;
esac
cd "$root/B"
sh -c "$1" probe "$$" "$root/home" "$root/A"
"#;
    for mode in [
        "cwd",
        "file-link",
        "directory-link",
        "broken-link",
        "missing",
    ] {
        let mut command = crate::process::headless_command("wsl.exe");
        command.args([
            "-d",
            "Ubuntu-22.04",
            "--exec",
            "sh",
            "-c",
            FIXTURE,
            "fixture",
            EDITOR_CONFIG_SCRIPT,
            mode,
        ]);
        let output =
            crate::process::output_with_timeout(&mut command, std::time::Duration::from_secs(5))
                .unwrap();
        if mode == "broken-link" {
            assert!(!output.status.success());
            continue;
        }
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let configs = parse_configs(&output.stdout).unwrap();
        assert_eq!(
            configs
                .iter()
                .any(|text| text.contains("submit = 'ctrl-u'")),
            mode != "missing",
            "{mode}"
        );
    }
}
