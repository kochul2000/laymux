use serde::{Deserialize, Serialize};

use super::models::{Settings, WorkspacePane};

/// A single validation warning describing an issue found in settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationWarning {
    /// Dot-separated path to the problematic field (e.g. "workspaces[0].panes[1].x").
    pub path: String,
    /// Human-readable description of the issue.
    pub message: String,
    /// Whether the issue was auto-repaired.
    pub repaired: bool,
}

/// Result of loading and validating settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SettingsLoadResult {
    /// Settings loaded and validated successfully (possibly with auto-repaired warnings).
    #[serde(rename = "ok")]
    Ok {
        settings: Settings,
        warnings: Vec<ValidationWarning>,
    },
    /// JSON was parseable but had structural issues that were auto-repaired.
    #[serde(rename = "repaired")]
    Repaired {
        settings: Settings,
        warnings: Vec<ValidationWarning>,
    },
    /// JSON could not be parsed at all. Default settings are provided.
    #[serde(rename = "parse_error")]
    ParseError {
        settings: Settings,
        error: String,
        settings_path: String,
    },
}

/// Validate settings and auto-repair where possible.
/// Returns the (possibly modified) settings and a list of warnings.
pub fn validate_and_repair(settings: &mut Settings) -> Vec<ValidationWarning> {
    let mut warnings = Vec::new();

    validate_workspaces(settings, &mut warnings);
    validate_layouts(settings, &mut warnings);
    validate_docks(settings, &mut warnings);
    validate_profile_references(settings, &mut warnings);

    // Ensure at least one workspace exists
    if settings.workspaces.is_empty() {
        let default = Settings::default();
        settings.workspaces = default.workspaces;
        warnings.push(ValidationWarning {
            path: "workspaces".into(),
            message: "워크스페이스가 비어 있어 기본 워크스페이스를 생성했습니다.".into(),
            repaired: true,
        });
    }

    // Ensure at least one profile exists
    if settings.profiles.is_empty() {
        let default = Settings::default();
        settings.profiles = default.profiles;
        warnings.push(ValidationWarning {
            path: "profiles".into(),
            message: "프로파일이 비어 있어 기본 프로파일을 생성했습니다.".into(),
            repaired: true,
        });
    }

    warnings
}

fn validate_workspaces(settings: &mut Settings, warnings: &mut Vec<ValidationWarning>) {
    for (ws_idx, ws) in settings.workspaces.iter_mut().enumerate() {
        let ws_path = format!("workspaces[{ws_idx}]");

        // Workspace must have an id
        if ws.id.is_empty() {
            ws.id = format!("ws-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            warnings.push(ValidationWarning {
                path: format!("{ws_path}.id"),
                message: "워크스페이스 ID가 비어 있어 새로 생성했습니다.".into(),
                repaired: true,
            });
        }

        // Workspace must have a name
        if ws.name.is_empty() {
            ws.name = format!("Workspace {}", ws_idx + 1);
            warnings.push(ValidationWarning {
                path: format!("{ws_path}.name"),
                message: "워크스페이스 이름이 비어 있어 기본 이름을 설정했습니다.".into(),
                repaired: true,
            });
        }

        // Validate panes
        validate_workspace_panes(&mut ws.panes, &ws_path, warnings);

        // If all panes were removed, add a default pane
        if ws.panes.is_empty() {
            ws.panes.push(default_workspace_pane());
            warnings.push(ValidationWarning {
                path: format!("{ws_path}.panes"),
                message: "유효한 Pane이 없어 기본 Pane을 추가했습니다.".into(),
                repaired: true,
            });
        }
    }
}

fn validate_workspace_panes(
    panes: &mut Vec<WorkspacePane>,
    parent_path: &str,
    warnings: &mut Vec<ValidationWarning>,
) {
    let mut to_remove = Vec::new();

    for (i, pane) in panes.iter_mut().enumerate() {
        let pane_path = format!("{parent_path}.panes[{i}]");

        // Check for NaN/Infinity coordinates first — not repairable, remove pane
        if pane.x.is_nan()
            || pane.y.is_nan()
            || pane.w.is_nan()
            || pane.h.is_nan()
            || pane.x.is_infinite()
            || pane.y.is_infinite()
            || pane.w.is_infinite()
            || pane.h.is_infinite()
        {
            to_remove.push(i);
            warnings.push(ValidationWarning {
                path: pane_path.clone(),
                message: "Pane 좌표에 NaN/Infinity 값이 있어 제거했습니다.".into(),
                repaired: true,
            });
            continue;
        }

        // Clamp coordinates to 0.0~1.0
        if !is_valid_ratio(pane.x) {
            let old = pane.x;
            pane.x = clamp_ratio(pane.x);
            warnings.push(ValidationWarning {
                path: format!("{pane_path}.x"),
                message: format!(
                    "x 좌표 {old}이(가) 유효 범위(0.0~1.0)를 벗어나 {:.2}로 수정했습니다.",
                    pane.x
                ),
                repaired: true,
            });
        }

        if !is_valid_ratio(pane.y) {
            let old = pane.y;
            pane.y = clamp_ratio(pane.y);
            warnings.push(ValidationWarning {
                path: format!("{pane_path}.y"),
                message: format!(
                    "y 좌표 {old}이(가) 유효 범위(0.0~1.0)를 벗어나 {:.2}로 수정했습니다.",
                    pane.y
                ),
                repaired: true,
            });
        }

        if !is_valid_dimension(pane.w) {
            let old = pane.w;
            pane.w = clamp_dimension(pane.w);
            warnings.push(ValidationWarning {
                path: format!("{pane_path}.w"),
                message: format!(
                    "w 크기 {old}이(가) 유효 범위(0.0~1.0, >0)를 벗어나 {:.2}로 수정했습니다.",
                    pane.w
                ),
                repaired: true,
            });
        }

        if !is_valid_dimension(pane.h) {
            let old = pane.h;
            pane.h = clamp_dimension(pane.h);
            warnings.push(ValidationWarning {
                path: format!("{pane_path}.h"),
                message: format!(
                    "h 크기 {old}이(가) 유효 범위(0.0~1.0, >0)를 벗어나 {:.2}로 수정했습니다.",
                    pane.h
                ),
                repaired: true,
            });
        }

        // View type must not be empty
        if pane.view.view_type.is_empty() {
            pane.view.view_type = "EmptyView".into();
            warnings.push(ValidationWarning {
                path: format!("{pane_path}.view.type"),
                message: "View 타입이 비어 있어 EmptyView로 설정했습니다.".into(),
                repaired: true,
            });
        }
    }

    // Remove invalid panes in reverse order to maintain indices
    for i in to_remove.into_iter().rev() {
        panes.remove(i);
    }
}

fn validate_layouts(settings: &mut Settings, warnings: &mut Vec<ValidationWarning>) {
    for (layout_idx, layout) in settings.layouts.iter_mut().enumerate() {
        let layout_path = format!("layouts[{layout_idx}]");

        if layout.id.is_empty() {
            layout.id = format!("layout-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            warnings.push(ValidationWarning {
                path: format!("{layout_path}.id"),
                message: "레이아웃 ID가 비어 있어 새로 생성했습니다.".into(),
                repaired: true,
            });
        }

        for (i, pane) in layout.panes.iter_mut().enumerate() {
            let pane_path = format!("{layout_path}.panes[{i}]");
            if !is_valid_ratio(pane.x) {
                pane.x = clamp_ratio(pane.x);
                warnings.push(ValidationWarning {
                    path: format!("{pane_path}.x"),
                    message: "레이아웃 Pane x 좌표를 유효 범위로 수정했습니다.".into(),
                    repaired: true,
                });
            }
            if !is_valid_ratio(pane.y) {
                pane.y = clamp_ratio(pane.y);
                warnings.push(ValidationWarning {
                    path: format!("{pane_path}.y"),
                    message: "레이아웃 Pane y 좌표를 유효 범위로 수정했습니다.".into(),
                    repaired: true,
                });
            }
            if !is_valid_dimension(pane.w) {
                pane.w = clamp_dimension(pane.w);
                warnings.push(ValidationWarning {
                    path: format!("{pane_path}.w"),
                    message: "레이아웃 Pane w 크기를 유효 범위로 수정했습니다.".into(),
                    repaired: true,
                });
            }
            if !is_valid_dimension(pane.h) {
                pane.h = clamp_dimension(pane.h);
                warnings.push(ValidationWarning {
                    path: format!("{pane_path}.h"),
                    message: "레이아웃 Pane h 크기를 유효 범위로 수정했습니다.".into(),
                    repaired: true,
                });
            }
            if pane.view_type.is_empty() {
                pane.view_type = "TerminalView".into();
                warnings.push(ValidationWarning {
                    path: format!("{pane_path}.viewType"),
                    message: "레이아웃 Pane viewType이 비어 있어 TerminalView로 설정했습니다."
                        .into(),
                    repaired: true,
                });
            }
        }
    }
}

fn validate_docks(settings: &mut Settings, warnings: &mut Vec<ValidationWarning>) {
    let valid_positions = ["top", "bottom", "left", "right"];
    for (dock_idx, dock) in settings.docks.iter_mut().enumerate() {
        let dock_path = format!("docks[{dock_idx}]");

        if !valid_positions.contains(&dock.position.as_str()) {
            warnings.push(ValidationWarning {
                path: format!("{dock_path}.position"),
                message: format!(
                    "독 위치 '{}'이(가) 유효하지 않습니다. 유효 값: top, bottom, left, right.",
                    dock.position
                ),
                repaired: false,
            });
        }

        if dock.size < 0.0 {
            dock.size = 240.0;
            warnings.push(ValidationWarning {
                path: format!("{dock_path}.size"),
                message: "독 크기가 음수여서 기본값(240)으로 수정했습니다.".into(),
                repaired: true,
            });
        }
    }
}

fn validate_profile_references(settings: &mut Settings, warnings: &mut Vec<ValidationWarning>) {
    let profile_names: Vec<String> = settings.profiles.iter().map(|p| p.name.clone()).collect();

    // Check workspace pane profile references
    for (ws_idx, ws) in settings.workspaces.iter().enumerate() {
        for (pane_idx, pane) in ws.panes.iter().enumerate() {
            if pane.view.view_type == "TerminalView" {
                if let Some(profile_name) = pane.view.extra.get("profile").and_then(|v| v.as_str())
                {
                    if !profile_name.is_empty()
                        && !profile_names.contains(&profile_name.to_string())
                    {
                        warnings.push(ValidationWarning {
                            path: format!("workspaces[{ws_idx}].panes[{pane_idx}].view.profile"),
                            message: format!(
                                "프로파일 '{profile_name}'이(가) 정의된 프로파일 목록에 없습니다."
                            ),
                            repaired: false,
                        });
                    }
                }
            }
        }
    }

    // Check default profile reference
    if !settings.default_profile.is_empty() && !profile_names.contains(&settings.default_profile) {
        warnings.push(ValidationWarning {
            path: "defaultProfile".into(),
            message: format!(
                "기본 프로파일 '{}'이(가) 정의된 프로파일 목록에 없습니다.",
                settings.default_profile
            ),
            repaired: false,
        });
    }
}

fn is_valid_ratio(v: f64) -> bool {
    v.is_finite() && (0.0..=1.0).contains(&v)
}

fn is_valid_dimension(v: f64) -> bool {
    v.is_finite() && v > 0.0 && v <= 1.0
}

fn clamp_ratio(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    v.clamp(0.0, 1.0)
}

fn clamp_dimension(v: f64) -> f64 {
    if !v.is_finite() || v <= 0.0 {
        return 0.1;
    }
    v.clamp(0.01, 1.0)
}

fn default_workspace_pane() -> WorkspacePane {
    WorkspacePane {
        id: format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]),
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
        view: super::models::WorkspacePaneView {
            view_type: "TerminalView".into(),
            extra: serde_json::json!({"profile": "PowerShell"}),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::models::*;

    // ── validate_and_repair: 정상 settings는 경고 없이 통과 ──

    #[test]
    fn valid_settings_produce_no_warnings() {
        let mut settings = Settings::default();
        let warnings = validate_and_repair(&mut settings);
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
    }

    // ── Pane 좌표 범위 검증 ──

    #[test]
    fn pane_x_out_of_range_is_clamped() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].x = 1.5;
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.workspaces[0].panes[0].x, 1.0);
        assert!(warnings.iter().any(|w| w.path.contains(".x") && w.repaired));
    }

    #[test]
    fn pane_negative_x_is_clamped() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].x = -0.5;
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.workspaces[0].panes[0].x, 0.0);
        assert!(warnings.iter().any(|w| w.path.contains(".x") && w.repaired));
    }

    #[test]
    fn pane_w_zero_is_repaired() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].w = 0.0;
        let warnings = validate_and_repair(&mut settings);
        assert!(settings.workspaces[0].panes[0].w > 0.0);
        assert!(warnings.iter().any(|w| w.path.contains(".w") && w.repaired));
    }

    #[test]
    fn pane_h_negative_is_repaired() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].h = -1.0;
        let warnings = validate_and_repair(&mut settings);
        assert!(settings.workspaces[0].panes[0].h > 0.0);
        assert!(warnings.iter().any(|w| w.path.contains(".h") && w.repaired));
    }

    // ── View 타입 검증 ──

    #[test]
    fn empty_view_type_set_to_empty_view() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].view.view_type = "".into();
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.workspaces[0].panes[0].view.view_type, "EmptyView");
        assert!(warnings.iter().any(|w| w.path.contains("view.type")));
    }

    // ── 빈 워크스페이스 복구 ──

    #[test]
    fn empty_workspaces_get_default() {
        let mut settings = Settings::default();
        settings.workspaces.clear();
        let warnings = validate_and_repair(&mut settings);
        assert!(!settings.workspaces.is_empty());
        assert!(warnings.iter().any(|w| w.path == "workspaces"));
    }

    // ── 빈 프로파일 복구 ──

    #[test]
    fn empty_profiles_get_default() {
        let mut settings = Settings::default();
        settings.profiles.clear();
        let warnings = validate_and_repair(&mut settings);
        assert!(!settings.profiles.is_empty());
        assert!(warnings.iter().any(|w| w.path == "profiles"));
    }

    // ── 워크스페이스 ID/이름 검증 ──

    #[test]
    fn workspace_empty_id_is_assigned() {
        let mut settings = Settings::default();
        settings.workspaces[0].id = "".into();
        let warnings = validate_and_repair(&mut settings);
        assert!(!settings.workspaces[0].id.is_empty());
        assert!(warnings.iter().any(|w| w.path.contains(".id")));
    }

    #[test]
    fn workspace_empty_name_gets_default() {
        let mut settings = Settings::default();
        settings.workspaces[0].name = "".into();
        let warnings = validate_and_repair(&mut settings);
        assert!(!settings.workspaces[0].name.is_empty());
        assert!(warnings.iter().any(|w| w.path.contains(".name")));
    }

    // ── Pane이 전부 제거되면 기본 Pane 추가 ──

    #[test]
    fn workspace_with_all_nan_panes_gets_default_pane() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes = vec![WorkspacePane {
            id: "pane-bad".into(),
            x: f64::NAN,
            y: f64::NAN,
            w: f64::NAN,
            h: f64::NAN,
            view: WorkspacePaneView {
                view_type: "TerminalView".into(),
                extra: serde_json::json!({}),
            },
        }];
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.workspaces[0].panes.len(), 1);
        assert_eq!(settings.workspaces[0].panes[0].x, 0.0);
        assert!(warnings.iter().any(|w| w.message.contains("NaN/Infinity")));
    }

    // ── 프로파일 참조 검증 ──

    #[test]
    fn nonexistent_profile_reference_warns() {
        let mut settings = Settings::default();
        settings.workspaces[0].panes[0].view.view_type = "TerminalView".into();
        settings.workspaces[0].panes[0].view.extra =
            serde_json::json!({"profile": "NonExistentProfile"});
        let warnings = validate_and_repair(&mut settings);
        assert!(warnings
            .iter()
            .any(|w| w.path.contains("profile") && !w.repaired));
    }

    #[test]
    fn nonexistent_default_profile_warns() {
        let mut settings = Settings::default();
        settings.default_profile = "DoesNotExist".into();
        let warnings = validate_and_repair(&mut settings);
        assert!(warnings
            .iter()
            .any(|w| w.path == "defaultProfile" && !w.repaired));
    }

    // ── 독 검증 ──

    #[test]
    fn dock_invalid_position_warns() {
        let mut settings = Settings::default();
        settings.docks.push(DockSetting {
            position: "diagonal".into(),
            active_view: None,
            views: vec![],
            visible: true,
            size: 240.0,
            panes: vec![],
        });
        let warnings = validate_and_repair(&mut settings);
        assert!(warnings
            .iter()
            .any(|w| w.path.contains("position") && !w.repaired));
    }

    #[test]
    fn dock_negative_size_repaired() {
        let mut settings = Settings::default();
        settings.docks[0].size = -100.0;
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.docks[0].size, 240.0);
        assert!(warnings
            .iter()
            .any(|w| w.path.contains("size") && w.repaired));
    }

    // ── 레이아웃 검증 ──

    #[test]
    fn layout_empty_id_is_assigned() {
        let mut settings = Settings::default();
        settings.layouts[0].id = "".into();
        let warnings = validate_and_repair(&mut settings);
        assert!(!settings.layouts[0].id.is_empty());
        assert!(warnings.iter().any(|w| w.path.contains("layouts[0].id")));
    }

    #[test]
    fn layout_pane_out_of_range_is_clamped() {
        let mut settings = Settings::default();
        settings.layouts[0].panes[0].x = 2.0;
        settings.layouts[0].panes[0].w = -0.5;
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.layouts[0].panes[0].x, 1.0);
        assert!(settings.layouts[0].panes[0].w > 0.0);
        assert!(warnings.len() >= 2);
    }

    #[test]
    fn layout_pane_empty_view_type_repaired() {
        let mut settings = Settings::default();
        settings.layouts[0].panes[0].view_type = "".into();
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.layouts[0].panes[0].view_type, "TerminalView");
        assert!(warnings
            .iter()
            .any(|w| w.path.contains("viewType") && w.repaired));
    }

    // ── SettingsLoadResult serde ──

    #[test]
    fn settings_load_result_ok_serializes() {
        let result = SettingsLoadResult::Ok {
            settings: Settings::default(),
            warnings: vec![],
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"status\":\"ok\""));
    }

    #[test]
    fn settings_load_result_parse_error_serializes() {
        let result = SettingsLoadResult::ParseError {
            settings: Settings::default(),
            error: "unexpected token".into(),
            settings_path: "/path/to/settings.json".into(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"status\":\"parse_error\""));
        assert!(json.contains("unexpected token"));
    }

    // ── JSON 파싱 실패 케이스 ──

    #[test]
    fn completely_invalid_json_yields_default() {
        let raw = "this is not json at all {{{";
        let result: Result<Settings, _> = serde_json::from_str(raw);
        assert!(result.is_err());
    }

    #[test]
    fn missing_required_fields_in_workspace_pane_view() {
        // WorkspacePaneView requires "type" field
        let json = r#"{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": {}}"#;
        let result: Result<WorkspacePane, _> = serde_json::from_str(json);
        // "type" is required in WorkspacePaneView (no default)
        assert!(result.is_err());
    }

    #[test]
    fn partial_json_with_extra_fields_still_parses() {
        let json = r#"{"unknownField": true, "profiles": []}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.profiles.is_empty());
    }

    // ── Multiple panes: valid + invalid mix ──

    #[test]
    fn mixed_valid_invalid_panes_keep_valid_ones() {
        let mut settings = Settings::default();
        let good_pane = settings.workspaces[0].panes[0].clone();
        let bad_pane = WorkspacePane {
            id: "pane-bad".into(),
            x: f64::NAN,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            view: WorkspacePaneView {
                view_type: "TerminalView".into(),
                extra: serde_json::json!({}),
            },
        };
        settings.workspaces[0].panes = vec![good_pane.clone(), bad_pane];
        let warnings = validate_and_repair(&mut settings);
        assert_eq!(settings.workspaces[0].panes.len(), 1);
        assert_eq!(settings.workspaces[0].panes[0].id, good_pane.id);
        assert!(warnings.iter().any(|w| w.message.contains("NaN/Infinity")));
    }
}
