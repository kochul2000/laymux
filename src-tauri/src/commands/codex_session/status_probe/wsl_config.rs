use base64::Engine;
use std::path::Path;
use std::time::Duration;

const CONFIG_TIMEOUT: Duration = Duration::from_secs(3);
const CONFIG_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const DIAGNOSTIC_FIELD_LIMIT: usize = 512;
const ERROR_FRAME: &[u8] = b"LAYMUX_CODEX_CONFIG_ERROR_V1\0";

// Values are positional arguments, never interpolated shell source. Read inside
// the distro: Windows UNC reads can mistake valid Linux symlinks for NotFound.
const EDITOR_CONFIG_SCRIPT: &str = r#"
set -eu
fail() {
  # NUL separates arbitrary Linux paths without copying configuration contents.
  printf 'LAYMUX_CODEX_CONFIG_ERROR_V1\000%s\000%s\000' "$1" "$2" >&2
  exit 1
}
[ -d "/proc/$1" ] || fail process.directory "/proc/$1"
actual_cwd=$(readlink -e -- "/proc/$1/cwd") || fail cwd.resolve "/proc/$1/cwd"
case "$actual_cwd" in /*) ;; *) fail cwd.absolute "/proc/$1/cwd";; esac
printf 'LAYMUX_CODEX_CONFIG_V1\n'
total=0
read_config() {
  file=$1
  if [ -e "$file" ] || [ -L "$file" ]; then
    if [ -L "$file" ] && [ ! -e "$file" ]; then
      fail config.symlink "$file"
    fi
    [ -f "$file" ] || fail config.type "$file"
    [ -r "$file" ] || fail config.readable "$file"
    size=$(wc -c < "$file") || fail config.size "$file"
    [ "$size" -le 262144 ] || fail config.file_limit "$file"
    total=$((total + size))
    [ "$total" -le 1048576 ] || fail config.total_limit "$file"
    printf C
    base64 -w0 -- "$file" || fail config.encode "$file"
    printf '\n'
  else
    # Only absence beneath an accessible directory is conclusive. Inaccessible
    # or dangling parent symlinks must not silently hide a real configuration.
    parent=$(dirname -- "$file") || fail config.parent "$file"
    while [ ! -e "$parent" ] && [ ! -L "$parent" ] && [ "$parent" != / ]; do
      parent=$(dirname -- "$parent") || fail config.parent "$file"
    done
    [ -d "$parent" ] && [ -x "$parent" ] || fail config.parent "$parent"
  fi
}
read_config "$2/config.toml"
read_config "$2/managed_config.toml"
for root in "$actual_cwd" "$3"; do
  case "$root" in /*) ;; *) fail cwd.absolute "$root";; esac
  while :; do
    read_config "$root/.codex/config.toml"
    [ "$root" != / ] || break
    root=$(dirname -- "$root") || fail config.parent "$root"
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
    let context = |detail: &str| diagnostic_context(distro, pid, detail);
    if !crate::wsl_probe::is_safe_distro_name(distro) {
        return Err(context("stage=input.distro; invalid WSL distribution name"));
    }
    let guest_path = |label: &str, path: &Path| -> Result<String, String> {
        let invalid = |reason: &str| {
            context(&format!(
                "stage=input.path; {label}={}; {reason}",
                diagnostic_text(&path.to_string_lossy())
            ))
        };
        let path = path
            .to_str()
            .ok_or_else(|| invalid("path is not valid Unicode"))?;
        let path = crate::path_utils::normalize_wsl_path(&path.replace('\\', "/"));
        if !path.starts_with('/') {
            return Err(invalid("WSL configuration requires an absolute guest path"));
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
        &guest_path("codexHome", codex_home)?,
        &guest_path("terminalCwd", terminal_cwd)?,
    ]);
    let output = crate::process::output_with_timeout(&mut command, CONFIG_TIMEOUT);
    read_config_result(distro, pid, output)
}

fn read_config_result(
    distro: &str,
    pid: u32,
    output: std::io::Result<std::process::Output>,
) -> Result<Vec<String>, String> {
    let context = |detail: &str| diagnostic_context(distro, pid, detail);
    let output = output.map_err(|error| {
        let stage = if error.kind() == std::io::ErrorKind::TimedOut {
            "process.timeout"
        } else {
            "process.execute"
        };
        context(&format!(
            "stage={stage}; {}",
            diagnostic_text(&error.to_string())
        ))
    })?;
    if !output.status.success() {
        let (detail, stderr) = guest_failure(&output.stderr).unwrap_or_else(|| {
            (
                "stage=process.exit; WSL inspection command failed before reporting a diagnostic"
                    .into(),
                output.stderr.as_slice(),
            )
        });
        let mut detail = format!("{detail}; {}", output.status);
        if !stderr.is_empty() {
            detail.push_str(&format!(
                "; stderr={}",
                diagnostic_text(&String::from_utf8_lossy(stderr))
            ));
        }
        return Err(context(&detail));
    }
    // stdout can contain whole configuration files. Never include it in errors.
    parse_configs(&output.stdout)
        .map_err(|error| context(&format!("stage=response.parse; {error}")))
}

fn diagnostic_context(distro: &str, pid: u32, detail: &str) -> String {
    format!(
        "Could not verify WSL Codex working directory or editor configuration [distro={}, pid={pid}]: {detail}",
        diagnostic_text(distro)
    )
}

fn diagnostic_text(text: &str) -> String {
    let mut result = String::new();
    for ch in text.trim().chars().flat_map(char::escape_debug) {
        if result.len() + ch.len_utf8() > DIAGNOSTIC_FIELD_LIMIT {
            result.push('…');
            break;
        }
        result.push(ch);
    }
    result
}

fn guest_failure(stderr: &[u8]) -> Option<(String, &[u8])> {
    let start = stderr
        .windows(ERROR_FRAME.len())
        .rposition(|part| part == ERROR_FRAME)?;
    let mut fields = stderr[start + ERROR_FRAME.len()..].split(|byte| *byte == 0);
    let stage = std::str::from_utf8(fields.next()?).ok()?;
    let path = fields.next()?;
    if fields.next()? != b"" || fields.next().is_some() {
        return None;
    }
    let reason = match stage {
        "process.directory" => "process directory is missing or inaccessible",
        "cwd.resolve" => "readlink could not resolve the process working directory",
        "cwd.absolute" => "working directory is not an absolute guest path",
        "config.symlink" => "configuration symlink target is missing or inaccessible",
        "config.type" => "configuration path is not a regular file",
        "config.readable" => "configuration file is not readable by the WSL user",
        "config.size" => "could not read configuration file size",
        "config.file_limit" => "configuration file exceeds the 262144-byte limit",
        "config.total_limit" => "configuration files exceed the 1048576-byte total limit",
        "config.encode" => "could not read or base64-encode the configuration file",
        "config.parent" => {
            "configuration parent directory is missing, inaccessible, or could not be resolved"
        }
        _ => return None,
    };
    Some((
        format!(
            "stage={stage}; path={}; {reason}",
            diagnostic_text(&String::from_utf8_lossy(path))
        ),
        &stderr[..start],
    ))
}

fn parse_configs(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.len() > CONFIG_RESPONSE_LIMIT {
        return Err("WSL configuration response exceeds the 2097152-byte limit".into());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "WSL configuration response is not valid UTF-8".to_owned())?;
    let records = text
        .strip_prefix("LAYMUX_CODEX_CONFIG_V1\n")
        .ok_or_else(|| "WSL configuration response header is missing or invalid".to_owned())?
        .strip_suffix("END\n")
        .ok_or_else(|| {
            "WSL configuration response is incomplete (missing END marker)".to_owned()
        })?;
    records
        .split_terminator('\n')
        .enumerate()
        .map(|(index, line)| {
            let invalid = |reason: &str| format!("WSL configuration record {} {reason}", index + 1);
            let data = line
                .strip_prefix('C')
                .ok_or_else(|| invalid("has an invalid prefix"))?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| invalid("contains invalid base64"))?;
            String::from_utf8(data).map_err(|_| invalid("is not valid UTF-8"))
        })
        .collect()
}

#[cfg(test)]
#[path = "wsl_config_tests.rs"]
mod tests;
