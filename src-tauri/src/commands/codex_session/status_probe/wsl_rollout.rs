use std::path::Path;
use std::time::Duration;

// UNC absence is insufficient: Linux symlinks can appear missing to Windows.
// Confirm absence in the guest before allowing Fresh to clear a restore ID.
const ABSENCE_SCRIPT: &str = r#"
set -eu
sessions="$1/sessions"
if [ -e "$sessions" ] || [ -L "$sessions" ]; then
  [ -d "$sessions" ] && [ -r "$sessions" ] && [ -x "$sessions" ] || exit 1
  found=$(find -L "$sessions" -maxdepth "$3" \( -type l -o -name "$2" \) -print -quit) || exit 1
  [ -z "$found" ] || exit 1
else
  parent=$(dirname -- "$sessions")
  while [ ! -e "$parent" ] && [ ! -L "$parent" ] && [ "$parent" != / ]; do
    parent=$(dirname -- "$parent")
  done
  [ -d "$parent" ] && [ -x "$parent" ] || exit 1
fi
printf 'LAYMUX_CODEX_ROLLOUT_ABSENT\n'
"#;

pub(super) fn require_absent(distro: &str, codex_home: &Path, id: &str) -> Result<(), String> {
    if !crate::wsl_probe::is_safe_distro_name(distro)
        || !crate::commands::claude_session::is_valid_session_id(id)
    {
        return Err("Invalid WSL Codex status target".into());
    }
    let path = codex_home.to_str().ok_or("Invalid WSL Codex home")?;
    let path = crate::path_utils::normalize_wsl_path(&path.replace('\\', "/"));
    if !path.starts_with('/') {
        return Err("WSL Codex home requires an absolute path".into());
    }
    let depth = u16::from(crate::constants::CODEX_SESSION_DIRECTORY_DEPTH) + 1;
    let mut command = crate::process::headless_command("wsl.exe");
    command.args([
        "-d",
        distro,
        "--exec",
        "sh",
        "-c",
        ABSENCE_SCRIPT,
        "laymux-codex-rollout",
        &path,
        &format!("rollout-*{id}*.jsonl"),
        &depth.to_string(),
    ]);
    let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    if !output.status.success() || output.stdout != b"LAYMUX_CODEX_ROLLOUT_ABSENT\n" {
        return Err("Could not prove WSL Codex rollout absence; existing or inaccessible history cannot be saved as Fresh".into());
    }
    Ok(())
}
