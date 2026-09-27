use base64::Engine;
use std::path::Path;
use std::time::Duration;

// Values are positional arguments, never interpolated shell source. Read inside
// the distro: Windows UNC reads can mistake valid Linux symlinks for NotFound.
const EDITOR_CONFIG_SCRIPT: &str = r#"
set -eu
actual_cwd=$(readlink -e -- "/proc/$1/cwd") || exit 1
case "$actual_cwd" in /*) ;; *) exit 1;; esac
printf 'LAYMUX_CODEX_CONFIG_V1\n'
total=0
read_config() {
  file=$1
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ -r "$file" ] || exit 1
    size=$(wc -c < "$file") || exit 1
    [ "$size" -le 262144 ] || exit 1
    total=$((total + size))
    [ "$total" -le 1048576 ] || exit 1
    printf C
    base64 -w0 -- "$file" || exit 1
    printf '\n'
  else
    # Only absence beneath an accessible directory is conclusive. Inaccessible
    # or dangling parent symlinks must not silently hide a real configuration.
    parent=$(dirname -- "$file")
    while [ ! -e "$parent" ] && [ ! -L "$parent" ] && [ "$parent" != / ]; do
      parent=$(dirname -- "$parent")
    done
    [ -d "$parent" ] && [ -x "$parent" ] || exit 1
  fi
}
read_config "$2/config.toml"
read_config "$2/managed_config.toml"
for root in "$actual_cwd" "$3"; do
  case "$root" in /*) ;; *) exit 1;; esac
  while :; do
    read_config "$root/.codex/config.toml"
    [ "$root" != / ] || break
    root=$(dirname -- "$root")
  done
done
for file in /etc/codex/config.toml /etc/codex/managed_config.toml /etc/codex/requirements.toml; do
  read_config "$file"
done
printf 'END\n'
"#;

pub(super) fn read_editor_configs(
    distro: &str,
    pid: u32,
    codex_home: &Path,
    terminal_cwd: &Path,
) -> Result<Vec<String>, String> {
    if !crate::wsl_probe::is_safe_distro_name(distro) {
        return Err("Could not verify the WSL distribution".into());
    }
    let guest_path = |path: &Path| -> Result<String, String> {
        let path = path.to_str().ok_or("Invalid WSL configuration path")?;
        let path = crate::path_utils::normalize_wsl_path(&path.replace('\\', "/"));
        if !path.starts_with('/') {
            return Err("WSL configuration requires absolute paths".into());
        }
        Ok(path)
    };
    let mut command = crate::process::headless_command("wsl.exe");
    command.args([
        "-d",
        distro,
        "--exec",
        "sh",
        "-c",
        EDITOR_CONFIG_SCRIPT,
        "laymux-codex-config",
        &pid.to_string(),
        &guest_path(codex_home)?,
        &guest_path(terminal_cwd)?,
    ]);
    let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not verify WSL Codex working directory or editor configuration".into());
    }
    parse_configs(&output.stdout)
}

fn parse_configs(bytes: &[u8]) -> Result<Vec<String>, String> {
    let invalid = || "Invalid or incomplete WSL Codex configuration response".to_owned();
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let records = text
        .strip_prefix("LAYMUX_CODEX_CONFIG_V1\n")
        .and_then(|text| text.strip_suffix("END\n"))
        .ok_or_else(invalid)?;
    records
        .split_terminator('\n')
        .map(|line| {
            let data = line.strip_prefix('C').ok_or_else(invalid)?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| invalid())?;
            String::from_utf8(data).map_err(|_| invalid())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let output = crate::process::output_with_timeout(
                &mut command,
                std::time::Duration::from_secs(5),
            )
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
}
