use std::path::PathBuf;

/// The app directory name, varying by build profile.
/// Release: "laymux" / Dev (debug_assertions): "laymux-dev"
fn app_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "laymux-dev"
    } else {
        "laymux"
    }
}

/// Returns the app's profile-specific config directory.
/// - Windows: `%APPDATA%\laymux` (release) or `%APPDATA%\laymux-dev` (dev)
/// - Linux: `~/.config/laymux` (release) or `~/.config/laymux-dev` (dev)
pub fn config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join(app_dir_name()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".config").join(app_dir_name()))
    }
}

/// Returns the temp directory prefix for this build profile.
/// Release: "laymux" / Dev: "laymux-dev"
pub fn temp_prefix() -> &'static str {
    if cfg!(debug_assertions) {
        "laymux-dev"
    } else {
        "laymux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_dir_name_is_laymux_dev_in_test() {
        // Tests always run with debug_assertions
        assert_eq!(app_dir_name(), "laymux-dev");
    }

    #[test]
    fn config_dir_returns_some() {
        let dir = config_dir();
        assert!(dir.is_some(), "config_dir() should return Some when env vars are set");
    }

    #[test]
    fn config_dir_ends_with_laymux_dev() {
        let dir = config_dir().unwrap();
        let dir_str = dir.to_string_lossy();
        assert!(
            dir_str.ends_with("laymux-dev"),
            "expected path ending with 'laymux-dev', got: {dir_str}"
        );
    }

    #[test]
    fn temp_prefix_is_laymux_dev_in_test() {
        assert_eq!(temp_prefix(), "laymux-dev");
    }
}
