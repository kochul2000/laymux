mod models;
mod preserve;
mod projection;
mod store;
pub(crate) use models::AttributionCoverage;
pub use models::LocalUiState;
pub use models::{CheckpointCommit, LocalSessionSnapshot};
pub(crate) use preserve::{content_views, for_each_view, preserve_unknown};
pub(crate) use projection::apply_configuration;
pub use projection::{portable_value, split_configuration};
pub use store::LocalStateStore;

pub fn state_path() -> Result<std::path::PathBuf, crate::error::AppError> {
    let name = if cfg!(debug_assertions) {
        "laymux-dev"
    } else {
        "laymux"
    };
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|p| std::path::PathBuf::from(p).join(".local/state"))
        });
    Ok(base
        .ok_or_else(|| {
            crate::error::AppError::Other("Cannot determine local state directory".into())
        })?
        .join(name)
        .join("state.db"))
}
#[cfg(test)]
mod tests;
