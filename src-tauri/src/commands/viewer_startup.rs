use serde::Deserialize;

use crate::path_utils;
use crate::settings::{ExtensionViewer, Profile};
use crate::terminal::{detect_shell_type, ShellType};

/// Structured external viewer request sent by the frontend. The file path stays
/// data until this backend validates the settings mapping and quotes it for the
/// selected profile's shell.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewerStartupRequest {
    pub command: String,
    pub path: String,
}

pub(crate) fn viewer_requires_default_wsl_distro(
    request: &ViewerStartupRequest,
    profile: &Profile,
) -> bool {
    if profile_shell_type(profile) != ShellType::PowerShell {
        return false;
    }
    let forward = request.path.replace('\\', "/");
    path_utils::extract_wsl_distro_from_path(&forward).is_none()
        && forward.starts_with('/')
        && !forward.starts_with("/mnt/")
}

pub(crate) fn build_viewer_startup(
    request: &ViewerStartupRequest,
    selected_profile: &Profile,
    mappings: &[ExtensionViewer],
    default_wsl_distro: Option<&str>,
) -> Result<String, String> {
    let extension = file_extension(&request.path)
        .ok_or_else(|| "External viewer path must have a file extension".to_string())?;
    let has_command_mapping = mappings.iter().any(|mapping| {
        mapping.command == request.command
            && mapping
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
    });
    if !has_command_mapping {
        return Err(format!(
            "External viewer request is not authorized for extension '{extension}' and command '{}'",
            request.command
        ));
    }

    let mapping = mappings.iter().find(|mapping| {
        mapping.command == request.command
            && mapping.profile == selected_profile.name
            && mapping
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
    });
    let mapping = if let Some(mapping) = mapping {
        mapping
    } else if mappings.iter().any(|mapping| {
        mapping.command == request.command
            && mapping.profile.trim().is_empty()
            && mapping
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
    }) {
        return Err(format!(
            "External viewer for extension '{extension}' requires an explicit terminal profile"
        ));
    } else {
        return Err(format!(
            "External viewer profile mismatch: command '{}' is not mapped to profile '{}' for extension '{extension}'",
            request.command, selected_profile.name
        ));
    };

    let forward = request.path.replace('\\', "/");
    let explicit_distro = path_utils::extract_wsl_distro_from_path(&forward);
    let linux_path = if explicit_distro.is_some() {
        path_utils::normalize_wsl_path(&forward)
    } else {
        request.path.clone()
    };

    let (converted_path, quoted_path) = match profile_shell_type(selected_profile) {
        ShellType::Wsl => {
            if let Some(source_distro) = explicit_distro.as_deref() {
                validate_explicit_wsl_distro(source_distro, &linux_path, selected_profile)?;
            }
            let converted = path_utils::convert_path_for_target_with_distro(
                &linux_path,
                "WSL",
                explicit_distro.as_deref(),
            )
            .ok_or_else(|| "Could not convert external viewer path for WSL".to_string())?;
            let quoted = quote_posix(&converted);
            (converted, quoted)
        }
        ShellType::PowerShell => {
            let distro = explicit_distro.as_deref().or(default_wsl_distro);
            let converted = path_utils::convert_path_for_target_with_distro(
                &linux_path,
                "PowerShell",
                distro,
            )
            .ok_or_else(|| {
                "Could not convert Linux viewer path for Windows: no WSL distro is available"
                    .to_string()
            })?;
            let quoted = quote_powershell(&converted);
            (converted, quoted)
        }
        ShellType::Other => {
            return Err(format!(
                "External viewers do not support the selected profile's unsupported shell: '{}'",
                selected_profile.command_line
            ));
        }
    };

    if converted_path.is_empty() {
        return Err("External viewer path must not be empty".into());
    }
    Ok(format!("{} {quoted_path}", mapping.command))
}

fn profile_shell_type(profile: &Profile) -> ShellType {
    let tokens = command_line_tokens(&profile.command_line);
    let executable = tokens.first().map(String::as_str).unwrap_or("");
    detect_shell_type(executable)
}

fn validate_explicit_wsl_distro(
    source_distro: &str,
    normalized_path: &str,
    selected_profile: &Profile,
) -> Result<(), String> {
    // /mnt/<drive> is Windows-backed and shared by every WSL distribution.
    if normalized_path.starts_with("/mnt/") {
        return Ok(());
    }

    match wsl_profile_distro(selected_profile)? {
        Some(selected_distro) if selected_distro.eq_ignore_ascii_case(source_distro) => Ok(()),
        Some(selected_distro) => Err(format!(
            "Explicit WSL path uses distribution '{source_distro}', but selected profile '{}' uses '{selected_distro}'",
            selected_profile.name
        )),
        None => Err(format!(
            "Explicit WSL path uses distribution '{source_distro}', but selected profile '{}' does not select a distribution",
            selected_profile.name
        )),
    }
}

fn wsl_profile_distro(profile: &Profile) -> Result<Option<String>, String> {
    const LONG_FLAG: &str = "--distribution";
    const LONG_FLAG_EQ: &str = "--distribution=";

    let tokens = command_line_tokens(&profile.command_line);
    let mut selected: Option<String> = None;
    let mut index = 1;
    while index < tokens.len() {
        let argument = &tokens[index];
        let lowercase = argument.to_ascii_lowercase();
        let value = if lowercase == "-d" || lowercase == LONG_FLAG {
            index += 1;
            tokens.get(index).cloned().ok_or_else(|| {
                format!(
                    "WSL profile '{}' has a distribution flag without a value",
                    profile.name
                )
            })?
        } else if lowercase.starts_with(LONG_FLAG_EQ) {
            argument[LONG_FLAG_EQ.len()..].to_string()
        } else {
            index += 1;
            continue;
        };

        if value.is_empty() {
            return Err(format!(
                "WSL profile '{}' has an empty distribution value",
                profile.name
            ));
        }
        if value.contains(['\'', '"']) {
            return Err(format!(
                "WSL profile '{}' uses quoted distribution values, but quoted distribution values are unsupported",
                profile.name
            ));
        }
        if let Some(previous) = selected.as_deref() {
            if !previous.eq_ignore_ascii_case(&value) {
                return Err(format!(
                    "WSL profile '{}' selects conflicting distributions '{previous}' and '{value}'",
                    profile.name
                ));
            }
        } else {
            selected = Some(value);
        }
        index += 1;
    }
    Ok(selected)
}

fn command_line_tokens(command_line: &str) -> Vec<String> {
    // Keep this identical to TerminalSession::command_line_to_command_with_startup.
    // Supporting quotes only here would validate a command line that the actual
    // PTY spawn path tokenizes differently.
    command_line
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn file_extension(path: &str) -> Option<String> {
    let segment = path.rsplit(['/', '\\']).next().unwrap_or("");
    let dot = segment.rfind('.')?;
    if dot == 0 || dot + 1 >= segment.len() {
        return None;
    }
    Some(segment[dot..].to_ascii_lowercase())
}

fn quote_posix(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

fn quote_powershell(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

#[cfg(test)]
mod tests;
