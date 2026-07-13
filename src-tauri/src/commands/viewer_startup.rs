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
    let executable = profile.command_line.split_whitespace().next().unwrap_or("");
    detect_shell_type(executable)
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
mod tests {
    use super::*;
    use crate::settings::{ExtensionViewer, Profile};

    fn profile(name: &str, command_line: &str) -> Profile {
        Profile {
            name: name.into(),
            command_line: command_line.into(),
            ..Profile::default()
        }
    }

    fn mapping(extensions: &[&str], command: &str, profile: &str) -> ExtensionViewer {
        ExtensionViewer {
            extensions: extensions.iter().map(|value| (*value).into()).collect(),
            command: command.into(),
            profile: profile.into(),
        }
    }

    #[test]
    fn extension_viewer_missing_profile_deserializes_as_empty() {
        let viewer: ExtensionViewer =
            serde_json::from_str(r#"{"extensions":[".md"],"command":"vi"}"#).unwrap();
        assert_eq!(viewer.profile, "");
    }

    #[test]
    fn windows_path_is_converted_and_posix_quoted_for_wsl_profile() {
        let request = ViewerStartupRequest {
            command: "vi".into(),
            path: "C:\\Users\\me\\My Notes.md".into(),
        };
        let result = build_viewer_startup(
            &request,
            &profile("Ubuntu", "wsl.exe -d Ubuntu"),
            &[mapping(&[".md"], "vi", "Ubuntu")],
            None,
        )
        .unwrap();

        assert_eq!(result, "vi '/mnt/c/Users/me/My Notes.md'");
    }

    #[test]
    fn mnt_path_is_converted_and_powershell_quoted_for_windows_profile() {
        let request = ViewerStartupRequest {
            command: "notepad".into(),
            path: "/mnt/c/Users/me/My Notes.md".into(),
        };
        let result = build_viewer_startup(
            &request,
            &profile("Windows", "pwsh.exe"),
            &[mapping(&[".md"], "notepad", "Windows")],
            None,
        )
        .unwrap();

        assert_eq!(result, "notepad 'C:\\Users\\me\\My Notes.md'");
    }

    #[test]
    fn pure_linux_path_uses_default_distro_unc_for_windows_profile() {
        let request = ViewerStartupRequest {
            command: "notepad".into(),
            path: "/home/me/README.md".into(),
        };
        let windows_profile = profile("Windows", "powershell.exe");
        assert!(viewer_requires_default_wsl_distro(
            &request,
            &windows_profile
        ));
        let result = build_viewer_startup(
            &request,
            &windows_profile,
            &[mapping(&[".md"], "notepad", "Windows")],
            Some("Ubuntu-24.04"),
        )
        .unwrap();

        assert_eq!(
            result,
            "notepad '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\README.md'"
        );
    }

    #[test]
    fn explicit_wsl_localhost_distro_is_preserved_for_each_target_shell() {
        let wsl = build_viewer_startup(
            &ViewerStartupRequest {
                command: "vi".into(),
                path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\README.md".into(),
            },
            &profile("Ubuntu", "wsl.exe -d Ubuntu"),
            &[mapping(&[".md"], "vi", "Ubuntu")],
            Some("Debian"),
        )
        .unwrap();
        assert_eq!(wsl, "vi '/home/me/README.md'");

        let windows_request = ViewerStartupRequest {
            command: "notepad".into(),
            path: "//wsl.localhost/Ubuntu-24.04/home/me/README.md".into(),
        };
        let windows_profile = profile("Windows", "powershell.exe");
        assert!(!viewer_requires_default_wsl_distro(
            &windows_request,
            &windows_profile
        ));
        let windows = build_viewer_startup(
            &windows_request,
            &windows_profile,
            &[mapping(&[".md"], "notepad", "Windows")],
            Some("Debian"),
        )
        .unwrap();
        assert_eq!(
            windows,
            "notepad '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\README.md'"
        );
    }

    #[test]
    fn quotes_single_quotes_for_each_target_shell() {
        let wsl = build_viewer_startup(
            &ViewerStartupRequest {
                command: "vi".into(),
                path: "C:\\Users\\O'Brien\\README.md".into(),
            },
            &profile("Ubuntu", "wsl.exe -d Ubuntu"),
            &[mapping(&[".md"], "vi", "Ubuntu")],
            None,
        )
        .unwrap();
        assert_eq!(wsl, "vi '/mnt/c/Users/O'\\''Brien/README.md'");

        let windows = build_viewer_startup(
            &ViewerStartupRequest {
                command: "notepad".into(),
                path: "/home/O'Brien/README.md".into(),
            },
            &profile("Windows", "powershell.exe"),
            &[mapping(&[".md"], "notepad", "Windows")],
            Some("Ubuntu"),
        )
        .unwrap();
        assert_eq!(
            windows,
            "notepad '\\\\wsl.localhost\\Ubuntu\\home\\O''Brien\\README.md'"
        );
    }

    #[test]
    fn rejects_requests_not_matching_extension_command_and_profile() {
        let request = ViewerStartupRequest {
            command: "vi".into(),
            path: "/home/me/README.md".into(),
        };
        let selected = profile("Ubuntu", "wsl.exe -d Ubuntu");

        assert!(build_viewer_startup(
            &request,
            &selected,
            &[mapping(&[".txt"], "vi", "Ubuntu")],
            None,
        )
        .is_err());
        assert!(build_viewer_startup(
            &request,
            &selected,
            &[mapping(&[".md"], "less", "Ubuntu")],
            None,
        )
        .is_err());
        assert!(build_viewer_startup(
            &request,
            &selected,
            &[mapping(&[".md"], "vi", "Debian")],
            None,
        )
        .is_err());
    }

    #[test]
    fn accepts_the_exact_profile_when_duplicate_extension_commands_exist() {
        let result = build_viewer_startup(
            &ViewerStartupRequest {
                command: "vi".into(),
                path: "/home/me/README.md".into(),
            },
            &profile("Ubuntu", "wsl.exe -d Ubuntu"),
            &[
                mapping(&[".md"], "vi", "Debian"),
                mapping(&[".md"], "vi", "Ubuntu"),
            ],
            None,
        )
        .unwrap();

        assert_eq!(result, "vi '/home/me/README.md'");
    }

    #[test]
    fn rejects_profiles_whose_shell_cannot_receive_a_startup_command() {
        let error = build_viewer_startup(
            &ViewerStartupRequest {
                command: "vi".into(),
                path: "/home/me/README.md".into(),
            },
            &profile("Cmd", "cmd.exe"),
            &[mapping(&[".md"], "vi", "Cmd")],
            None,
        )
        .unwrap_err();

        assert!(error.contains("unsupported shell"));
    }
}
