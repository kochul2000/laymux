//! Explicit workspace/pane selectors shared by MCP layout tools.
use rmcp::schemars;
use serde_json::Value;

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct PaneIndexParam {
    /// Pane index (0-based)
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace to focus; omitted uses the pane id owner or the current workspace. This is explicit navigation.
    pub(super) workspace_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum SplitDirection {
    Horizontal,
    Vertical,
}

impl std::fmt::Display for SplitDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SplitDirection::Horizontal => write!(f, "horizontal"),
            SplitDirection::Vertical => write!(f, "vertical"),
        }
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct SplitPaneParam {
    /// Optional 0-based slot index within workspace_id. Provide pane_id or pane_index.
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) workspace_id: Option<String>,
    /// horizontal splits top/bottom (new pane below); vertical splits left/right (new pane right).
    pub(super) direction: SplitDirection,
    /// Terminal profile name for the new pane (e.g. "PowerShell", "WSL"). Use list_profiles to see available profiles.
    pub(super) profile: Option<String>,
    /// Initial working directory; omitted inherits the split pane's active-layer CWD.
    pub(super) cwd: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct StackPaneParam {
    /// Optional 0-based slot index within workspace_id. Provide pane_id or pane_index.
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) workspace_id: Option<String>,
    /// View type of the new layer (default "TerminalView")
    pub(super) view_type: Option<String>,
    /// Terminal profile name for the new layer (e.g. "PowerShell", "WSL")
    pub(super) profile: Option<String>,
    /// Initial working directory; omitted → the slot's active layer CWD
    pub(super) cwd: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ActivatePaneLayerParam {
    /// Stable layer id from list_workspaces or get_active_workspace. Provide exactly one of layer_id and terminal_id.
    pub(super) layer_id: Option<String>,
    /// Terminal id of the layer (e.g. "terminal-pane-1234abcd"). Provide exactly one of layer_id and terminal_id.
    pub(super) terminal_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct MovePaneLayerParam {
    /// Owning workspace; omitted uses the layer id owner or the current workspace for indices.
    pub(super) workspace_id: Option<String>,
    /// Stable layer id from list_workspaces or get_active_workspace. Provide exactly one of layer_id and terminal_id.
    pub(super) layer_id: Option<String>,
    /// Terminal id of the layer (e.g. "terminal-pane-1234abcd"). Provide exactly one of layer_id and terminal_id.
    pub(super) terminal_id: Option<String>,
    /// Pane slot index in the selected workspace (0-based). Moving onto its own slot reorders.
    pub(super) target_pane_index: u64,
    /// Position among the target slot's other layers (default: after its active layer)
    pub(super) index: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct ExtractPaneLayerParam {
    /// Owning workspace; omitted uses the layer id owner or the current workspace for indices.
    pub(super) workspace_id: Option<String>,
    /// Stable layer id from list_workspaces or get_active_workspace. Provide exactly one of layer_id and terminal_id.
    pub(super) layer_id: Option<String>,
    /// Terminal id of the layer (e.g. "terminal-pane-1234abcd"). Provide exactly one of layer_id and terminal_id.
    pub(super) terminal_id: Option<String>,
    /// Split direction of the new slot, as in split_pane
    pub(super) direction: SplitDirection,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct MergePanesParam {
    /// Owning workspace; omitted uses the layer id owner or the current workspace for indices.
    pub(super) workspace_id: Option<String>,
    /// Source slot index in the selected workspace (0-based). All layers move and this slot is removed.
    pub(super) source_index: u64,
    /// Target slot index in the selected workspace (0-based) that receives the layers.
    pub(super) target_index: u64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct MovePaneToWorkspaceParam {
    /// Optional 0-based slot index within source_workspace_id; every layer moves.
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) source_workspace_id: Option<String>,
    /// Target workspace id (from list_workspaces)
    pub(super) workspace_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct RemovePaneParam {
    /// Optional 0-based slot index within workspace_id. Provide pane_id or pane_index.
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) workspace_id: Option<String>,
    /// Layer to close in a stacked slot (default: the active layer). Closing the
    /// last layer removes the slot.
    pub(super) layer_id: Option<String>,
}

/// Resize a pane by adjusting its dimensions.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct ResizePaneParam {
    /// Pane index to resize (0-based)
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) workspace_id: Option<String>,
    /// Width delta in normalized workspace units, limited by the shared boundary.
    /// 0.1 requests 10 percentage points of workspace width, subject to neighbor/minimum sizes.
    #[serde(default)]
    pub(super) dw: Option<f64>,
    /// Height delta in normalized workspace units, limited by the shared boundary.
    /// -0.1 requests 10 percentage points less workspace height, subject to neighbor/minimum sizes.
    #[serde(default)]
    pub(super) dh: Option<f64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct SwapPanesParam {
    /// Owning workspace; omitted uses the layer id owner or the current workspace for indices.
    pub(super) workspace_id: Option<String>,
    /// First pane index (0-based)
    pub(super) source_index: u64,
    /// Second pane index (0-based)
    pub(super) target_index: u64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct SetPaneViewParam {
    /// Pane index (0-based)
    pub(super) pane_index: Option<u64>,
    /// Stable slot or layer id. Resolves its workspace directly; no switch_workspace needed.
    pub(super) pane_id: Option<String>,
    /// Workspace containing the target; omitted uses the id owner or current workspace. Never navigates.
    pub(super) workspace_id: Option<String>,
    /// View config object, e.g. {"type":"TerminalView","profile":"PowerShell"}.
    pub(super) view: Value,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct WorkspaceScopeParam {
    /// Workspace to inspect without navigating; omitted means the active workspace.
    pub(super) workspace_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn accepts_direct_target<T: DeserializeOwned + schemars::JsonSchema>(extra: Value) {
        let mut stable = extra.clone();
        stable["pane_id"] = json!("background-layer");
        assert!(serde_json::from_value::<T>(stable).is_ok());
        let mut scoped = extra;
        scoped["workspace_id"] = json!("background");
        scoped["pane_index"] = json!(1);
        assert!(serde_json::from_value::<T>(scoped.clone()).is_ok());
        scoped["pane_index"] = json!(-1);
        assert!(serde_json::from_value::<T>(scoped).is_err());
        let schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        assert!(schema["properties"].get("pane_id").is_some());
        assert!(schema["properties"].get("workspace_id").is_some());
    }

    #[test]
    fn single_pane_tools_accept_stable_ids_and_background_workspace_indices() {
        accepts_direct_target::<PaneIndexParam>(json!({}));
        accepts_direct_target::<SplitPaneParam>(json!({"direction":"vertical"}));
        accepts_direct_target::<StackPaneParam>(json!({}));
        accepts_direct_target::<RemovePaneParam>(json!({"layer_id":"background-layer"}));
        accepts_direct_target::<ResizePaneParam>(json!({"dw":0.1}));
        accepts_direct_target::<SetPaneViewParam>(json!({"view":{"type":"MemoView"}}));
        let moved: MovePaneToWorkspaceParam = serde_json::from_value(json!({
            "pane_id":"background-layer", "source_workspace_id":"source", "workspace_id":"destination"
        })).unwrap();
        assert_eq!(moved.source_workspace_id.as_deref(), Some("source"));
        assert_eq!(moved.workspace_id, "destination");
        assert!(moved.pane_index.is_none());
    }

    #[test]
    fn rearrangement_and_grid_queries_can_be_scoped_without_navigation() {
        let merged: MergePanesParam = serde_json::from_value(
            json!({"workspace_id":"background","source_index":0,"target_index":1}),
        )
        .unwrap();
        assert_eq!(merged.workspace_id.as_deref(), Some("background"));
        let swapped: SwapPanesParam = serde_json::from_value(
            json!({"workspace_id":"background","source_index":0,"target_index":1}),
        )
        .unwrap();
        assert_eq!(swapped.workspace_id.as_deref(), Some("background"));
        let layer: MovePaneLayerParam = serde_json::from_value(
            json!({"workspace_id":"background","layer_id":"layer","target_pane_index":1}),
        )
        .unwrap();
        assert_eq!(layer.workspace_id.as_deref(), Some("background"));
        let extracted: ExtractPaneLayerParam = serde_json::from_value(json!({"workspace_id":"background","terminal_id":"terminal-layer","direction":"horizontal"})).unwrap();
        assert_eq!(extracted.workspace_id.as_deref(), Some("background"));
        let grid: WorkspaceScopeParam =
            serde_json::from_value(json!({"workspace_id":"background"})).unwrap();
        assert_eq!(grid.workspace_id.as_deref(), Some("background"));
    }
}
