use serde::{Deserialize, Serialize};

/// Immutable classification of the process target selected for the initial PTY
/// spawn. Runtime activity inside that shell does not change this value.
#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InitialExecutionHost {
    NativeWindows,
    Wsl,
    DirectSsh,
    NonWindows,
    #[default]
    Unknown,
}

impl InitialExecutionHost {
    pub(crate) fn classify_spawn_target(target: Option<&str>, windows: bool) -> Self {
        let Some(target) = target.map(str::trim).filter(|target| !target.is_empty()) else {
            return Self::Unknown;
        };
        if !windows {
            return Self::NonWindows;
        }

        // Treat both separators explicitly so cross-platform tests classify a
        // Windows target exactly like a Windows build would.
        let basename = target
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(target)
            .to_ascii_lowercase();
        let stem = basename.strip_suffix(".exe").unwrap_or(&basename);
        match stem {
            "wsl" => Self::Wsl,
            "ssh" => Self::DirectSsh,
            _ => Self::NativeWindows,
        }
    }

    pub(crate) fn for_current_platform(target: Option<&str>) -> Self {
        Self::classify_spawn_target(target, cfg!(windows))
    }
}
