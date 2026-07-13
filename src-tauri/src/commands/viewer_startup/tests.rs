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
fn matching_explicit_wsl_distro_is_normalized_for_wsl_profile() {
    let wsl = build_viewer_startup(
        &ViewerStartupRequest {
            command: "vi".into(),
            path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\README.md".into(),
        },
        &profile(
            "Ubuntu",
            "C:\\Windows\\System32\\WSL.EXE --distribution ubuntu-24.04",
        ),
        &[mapping(&[".md"], "vi", "Ubuntu")],
        None,
    )
    .unwrap();
    assert_eq!(wsl, "vi '/home/me/README.md'");
}

#[test]
fn rejects_explicit_wsl_distro_that_differs_from_selected_profile() {
    let error = build_viewer_startup(
        &ViewerStartupRequest {
            command: "vi".into(),
            path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\README.md".into(),
        },
        &profile("Debian", "wsl.exe -d Debian"),
        &[mapping(&[".md"], "vi", "Debian")],
        None,
    )
    .unwrap_err();

    assert!(error.contains("Ubuntu-24.04"));
    assert!(error.contains("Debian"));
}

#[test]
fn rejects_explicit_pure_linux_wsl_path_for_bare_wsl_profile() {
    let error = build_viewer_startup(
        &ViewerStartupRequest {
            command: "vi".into(),
            path: "//wsl.localhost/Ubuntu-24.04/home/me/README.md".into(),
        },
        &profile("WSL", "wsl.exe"),
        &[mapping(&[".md"], "vi", "WSL")],
        None,
    )
    .unwrap_err();

    assert!(error.contains("Ubuntu-24.04"));
    assert!(error.contains("does not select a distribution"));
}

#[test]
fn explicit_wsl_mnt_path_is_shared_across_distros() {
    let result = build_viewer_startup(
        &ViewerStartupRequest {
            command: "vi".into(),
            path: "\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c\\Users\\me\\README.md".into(),
        },
        &profile("WSL", "wsl.exe"),
        &[mapping(&[".md"], "vi", "WSL")],
        None,
    )
    .unwrap();

    assert_eq!(result, "vi '/mnt/c/Users/me/README.md'");
}

#[test]
fn extracts_supported_case_insensitive_wsl_distribution_arguments() {
    assert_eq!(
        wsl_profile_distro(&profile(
            "Ubuntu",
            "C:\\Windows\\System32\\WSL.EXE -D Ubuntu-24.04",
        ))
        .unwrap(),
        Some("Ubuntu-24.04".into())
    );
    assert_eq!(
        wsl_profile_distro(&profile("Debian", "wsl.exe --DISTRIBUTION=Debian")).unwrap(),
        Some("Debian".into())
    );
}

#[test]
fn rejects_quoted_wsl_distribution_values_outside_the_shared_parser_contract() {
    let error = build_viewer_startup(
        &ViewerStartupRequest {
            command: "vi".into(),
            path: "//wsl.localhost/Ubuntu-24.04/home/me/README.md".into(),
        },
        &profile("Ubuntu", "wsl.exe -d \"Ubuntu-24.04\""),
        &[mapping(&[".md"], "vi", "Ubuntu")],
        None,
    )
    .unwrap_err();

    assert!(error.contains("quoted distribution values are unsupported"));
}

#[test]
fn explicit_wsl_localhost_distro_is_preserved_for_windows_shell() {
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
