//! MCP exposes laymux observations only; Git inspection/removal stays with agents.

use rmcp::schemars;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::AppState;
use crate::worktree_usage::{usage_for_path, UsageSnapshot};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct WorktreeUsageParam {
    /// Absolute worktree directory. On Windows, WSL paths must name the distro:
    /// //wsl.localhost/Ubuntu/home/user/repository.
    pub path: String,
}

pub(super) fn query(state: &AppState, path: &str) -> Result<Value, AppError> {
    let path = crate::worktree::canonicalize_host_path(path)?;
    let snapshot = crate::worktree_usage::collect_usage(state)?;
    Ok(project(&path, snapshot))
}

fn project(path: &str, snapshot: UsageSnapshot) -> Value {
    json!({
        "path": path,
        "scope": "current_build",
        "complete": snapshot.complete,
        "usage": usage_for_path(&snapshot.usage, path),
        "warnings": snapshot.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree_usage::{UsageKind, WorktreeUsage};

    #[test]
    fn worktree_usage_mcp_keeps_hidden_saved_references_and_directory_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let tree = temp.path().join("tree");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        let path = crate::worktree::canonicalize_host_path(tree.to_str().unwrap()).unwrap();
        let usage = |cwd: String| WorktreeUsage {
            terminal_id: Some("terminal-hidden".into()),
            pane_id: Some("hidden".into()),
            workspace_id: Some("workspace-hidden".into()),
            workspace_name: Some("숨은 작업".into()),
            cwd,
            kind: UsageKind::Saved,
            agent_type: None,
        };
        let result = project(
            &path,
            UsageSnapshot {
                complete: true,
                warnings: vec![],
                usage: vec![usage(format!("{path}/src")), usage(format!("{path}-other"))],
            },
        );
        assert_eq!(result["scope"], "current_build");
        assert_eq!(result["usage"].as_array().unwrap().len(), 1);
        assert_eq!(result["usage"][0]["kind"], "saved");
        assert_eq!(result["usage"][0]["workspaceName"], "숨은 작업");
        for field in ["canRemove", "head", "branch", "trackedChanges"] {
            assert!(
                result.get(field).is_none(),
                "Git policy leaked into usage MCP: {field}"
            );
        }
    }

    #[test]
    fn worktree_usage_mcp_empty_matches_do_not_hide_incomplete_observations() {
        let result = project(
            "D:/tree",
            UsageSnapshot {
                complete: false,
                usage: vec![],
                warnings: vec!["daemon CWD unavailable".into()],
            },
        );
        assert_eq!(result["complete"], false);
        assert_eq!(result["usage"], json!([]));
        assert_eq!(result["warnings"], json!(["daemon CWD unavailable"]));
        assert!(serde_json::from_value::<WorktreeUsageParam>(
            json!({"path":"D:/tree", "force":true})
        )
        .is_err());
    }
}
