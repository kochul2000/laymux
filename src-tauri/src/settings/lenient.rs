//! Partial recovery for `settings.json` type errors.
//!
//! A single mistyped value must not cost the whole file. Instead of letting the
//! first type mismatch fail `Settings` deserialization outright, this module
//! removes the offending JSON path from the value tree and retries, so the
//! field falls back to its own `#[serde(default)]` while every other setting
//! survives. Removed paths are reported as warnings — never silently.
//!
//! Values are dropped, never coerced: dropping reuses each field's existing
//! default as the single source of truth, so adding a field never requires
//! touching the recovery path. See ADR-0119.

use serde_json::Value;
use serde_path_to_error::Segment;

use super::models::Settings;
use super::validation::ValidationWarning;

mod duplicate_keys;
mod original_paths;

use original_paths::OriginalPathTree;

/// Upper bound on paths a single load may drop before the file is declared
/// unrecoverable.
///
/// This is **not** what makes the loop terminate — every drop removes a node, so
/// the tree strictly shrinks and the loop always ends. The bound exists because
/// each retry re-deserializes the whole tree, making a badly broken file cost
/// O(drops × size); it caps that work.
///
/// Hitting it means giving up on partial recovery entirely (there is no
/// `Settings` to return until the tree parses), which is the outcome #701 exists
/// to prevent — so it is set far above any plausible hand-edit. A 130-workspace
/// file has a few hundred coordinates in total; a user who mistypes thousands of
/// them has a generated file, not an edited one.
const MAX_DROPPED_PATHS: usize = 2_000;

/// Settings recovered from a value tree, plus the paths that had to be dropped.
#[derive(Debug)]
pub(crate) struct LenientSettings {
    pub settings: Settings,
    /// One warning per dropped path. Empty when the file deserialized cleanly.
    pub dropped: Vec<ValidationWarning>,
}

/// Deserialize `Settings` from raw JSON, dropping type-error paths one at a time.
///
/// Returns `Err` only when nothing can be salvaged: a JSON syntax error, a
/// duplicate object key, a root-level type error, or more drops than
/// [`MAX_DROPPED_PATHS`].
pub(crate) fn deserialize_lenient(raw: &str) -> Result<LenientSettings, String> {
    let mut value = duplicate_keys::parse_value(raw)?;

    // serde accepts a struct in sequence form, so a root array would "recover"
    // by dropping every element down to an empty settings object. A settings
    // file that is not a JSON object is malformed, not partially salvageable.
    if !value.is_object() {
        return Err("settings.json 최상위가 JSON 객체가 아닙니다".to_string());
    }

    let mut original_paths = OriginalPathTree::from_value(&value);
    let mut dropped: Vec<ValidationWarning> = Vec::new();

    loop {
        let err = match serde_path_to_error::deserialize::<_, Settings>(&value) {
            Ok(settings) => return Ok(LenientSettings { settings, dropped }),
            Err(err) => err,
        };

        if dropped.len() >= MAX_DROPPED_PATHS {
            return Err(format!(
                "타입 오류가 {MAX_DROPPED_PATHS}개에 도달해 복구를 중단했습니다: {err}"
            ));
        }

        let reason = err.inner().to_string();
        let segments: Vec<Segment> = err.path().iter().cloned().collect();
        let Some(removed_path) =
            drop_deepest_resolvable(&mut value, &mut original_paths, &segments)
        else {
            return Err(err.to_string());
        };

        dropped.push(ValidationWarning {
            path: removed_path,
            message: format!(
                "값의 타입이 올바르지 않아 항목을 제거하고 기본값을 사용합니다: {reason}"
            ),
            repaired: true,
        });
    }
}

/// Remove the node addressed by the longest resolvable prefix of `segments`.
///
/// The error path can point deeper than the tree actually goes (a missing field
/// names a key that isn't there) or contain segments that don't address JSON
/// structure at all (enum variants). Walking as far as the tree allows and
/// dropping there keeps the loss as small as the structure permits.
///
/// Returns the path that was removed, in the repo's `a.b[0].c` warning style,
/// or `None` when nothing can be removed (the root itself is the wrong type).
fn drop_deepest_resolvable(
    root: &mut Value,
    original_paths: &mut OriginalPathTree,
    segments: &[Segment],
) -> Option<String> {
    let depth = resolvable_depth(root, segments);
    if depth == 0 {
        return None;
    }

    let removed_path = original_paths.format_path(&segments[..depth])?;
    let (parent_segments, last) = segments[..depth].split_at(depth - 1);
    let last = &last[0];

    let mut parent = &mut *root;
    let mut original_parent = original_paths;
    for segment in parent_segments {
        parent = descend_mut(parent, segment)?;
        original_parent = original_parent.descend_mut(segment)?;
    }

    match last {
        Segment::Map { key } => {
            let object = parent.as_object_mut()?;
            if !object.contains_key(key) || !original_parent.contains(last) {
                return None;
            }
            object.remove(key);
            original_parent.remove(last)?;
        }
        Segment::Seq { index } => {
            let array = parent.as_array_mut()?;
            if *index >= array.len() || !original_parent.contains(last) {
                return None;
            }
            array.remove(*index);
            original_parent.remove(last)?;
        }
        _ => return None,
    }

    Some(removed_path)
}

/// How many leading segments of `segments` actually address existing nodes.
fn resolvable_depth(root: &Value, segments: &[Segment]) -> usize {
    let mut current = root;
    let mut depth = 0;
    for segment in segments {
        match descend(current, segment) {
            Some(next) => {
                current = next;
                depth += 1;
            }
            None => break,
        }
    }
    depth
}

fn descend<'a>(value: &'a Value, segment: &Segment) -> Option<&'a Value> {
    match segment {
        Segment::Map { key } => value.as_object()?.get(key),
        Segment::Seq { index } => value.as_array()?.get(*index),
        _ => None,
    }
}

fn descend_mut<'a>(value: &'a mut Value, segment: &Segment) -> Option<&'a mut Value> {
    match segment {
        Segment::Map { key } => value.as_object_mut()?.get_mut(key),
        Segment::Seq { index } => value.as_array_mut()?.get_mut(*index),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_settings_drop_nothing() {
        // Compare against the very instance that was serialized — Settings::default()
        // mints a fresh pane uuid on every call.
        let original = Settings::default();
        let raw = serde_json::to_string(&original).unwrap();
        let recovered = deserialize_lenient(&raw).unwrap();
        assert!(recovered.dropped.is_empty());
        assert_eq!(recovered.settings, original);
    }

    #[test]
    fn duplicate_json_keys_are_rejected_before_value_conversion() {
        let err = deserialize_lenient(r#"{"language":"en","language":"ko"}"#)
            .expect_err("duplicate keys must not be silently overwritten");

        assert!(err.contains("duplicate field `language`"), "err: {err}");
    }

    #[test]
    fn string_for_number_drops_only_that_field() {
        // issue #701: a single mistyped knob must not reset the whole file.
        let raw = r#"{
          "language": "en",
          "defaultProfile": "WSL",
          "terminal": { "parserAdmission": { "hiddenShare": "2", "focusedShare": 7 } }
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();

        // Everything else survives.
        assert_eq!(recovered.settings.language, "en");
        assert_eq!(recovered.settings.default_profile, "WSL");
        assert_eq!(
            recovered.settings.terminal.parser_admission.focused_share,
            7
        );

        // The bad field fell back to its own serde default.
        let default_hidden = Settings::default().terminal.parser_admission.hidden_share;
        assert_eq!(
            recovered.settings.terminal.parser_admission.hidden_share,
            default_hidden
        );

        assert_eq!(recovered.dropped.len(), 1);
        assert_eq!(
            recovered.dropped[0].path,
            "terminal.parserAdmission.hiddenShare"
        );
        assert!(recovered.dropped[0].repaired);
    }

    #[test]
    fn null_and_fractional_numbers_are_dropped_too() {
        let raw = r#"{
          "terminal": { "parserAdmission": { "hiddenShare": null, "visibleShare": 1.5 } }
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();
        let defaults = Settings::default();
        assert_eq!(
            recovered.settings.terminal.parser_admission.hidden_share,
            defaults.terminal.parser_admission.hidden_share
        );
        assert_eq!(
            recovered.settings.terminal.parser_admission.visible_share,
            defaults.terminal.parser_admission.visible_share
        );
        assert_eq!(recovered.dropped.len(), 2);
    }

    #[test]
    fn multiple_unrelated_type_errors_all_drop() {
        let raw = r#"{
          "language": 42,
          "defaultProfile": "WSL",
          "appearance": { "themeId": true }
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();
        assert_eq!(recovered.settings.default_profile, "WSL");
        assert_eq!(recovered.settings.language, Settings::default().language);
        assert_eq!(
            recovered.settings.appearance.theme_id,
            Settings::default().appearance.theme_id
        );

        let paths: Vec<&str> = recovered.dropped.iter().map(|w| w.path.as_str()).collect();
        assert!(paths.contains(&"language"), "paths: {paths:?}");
        assert!(paths.contains(&"appearance.themeId"), "paths: {paths:?}");
    }

    #[test]
    fn bad_array_element_is_removed_and_siblings_kept() {
        let raw = r#"{
          "profiles": [
            { "name": "Keep", "commandLine": "pwsh.exe" },
            { "name": "Bad", "commandLine": 12345 },
            { "name": "AlsoKeep", "commandLine": "bash" }
          ]
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();
        let names: Vec<&str> = recovered
            .settings
            .profiles
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(names, vec!["Keep", "Bad", "AlsoKeep"]);
        // Only the mistyped field is dropped — the profile itself survives with
        // its default commandLine.
        assert_eq!(recovered.dropped.len(), 1);
        assert_eq!(recovered.dropped[0].path, "profiles[1].commandLine");
    }

    #[test]
    fn missing_required_field_widens_the_drop_to_the_parent() {
        // WorkspacePaneView.type has no default. A mistyped `type` first drops
        // the key, then the parent view, then the pane — loss grows outward
        // only as far as the schema forces.
        let raw = r#"{
          "workspaces": [
            {
              "id": "ws-1",
              "name": "Keep me",
              "panes": [
                { "id": "p1", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": { "type": 5 } }
              ]
            }
          ]
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();
        // The workspace itself survives with its name.
        assert_eq!(recovered.settings.workspaces.len(), 1);
        assert_eq!(recovered.settings.workspaces[0].name, "Keep me");
        assert!(recovered.settings.workspaces[0].panes.is_empty());

        let paths: Vec<&str> = recovered.dropped.iter().map(|w| w.path.as_str()).collect();
        assert!(
            paths.contains(&"workspaces[0].panes[0]"),
            "the pane must be reported as lost: {paths:?}"
        );
    }

    #[test]
    fn removed_array_items_keep_their_original_warning_indices() {
        let raw = r#"{
          "workspaces": [
            {
              "id": "ws-1",
              "name": "Keep me",
              "panes": [
                { "id": "p1", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": { "type": 5 } },
                { "id": "p2", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": { "type": 6 } }
              ]
            }
          ]
        }"#;

        let recovered = deserialize_lenient(raw).unwrap();
        let paths: Vec<&str> = recovered.dropped.iter().map(|w| w.path.as_str()).collect();

        assert!(
            paths.contains(&"workspaces[0].panes[0]"),
            "first original pane must be reported: {paths:?}"
        );
        assert!(
            paths.contains(&"workspaces[0].panes[1]"),
            "second original pane must be reported: {paths:?}"
        );
    }

    #[test]
    fn mistyped_pane_coordinate_costs_only_that_field() {
        // x/y carry a serde default like w/h, so a bad coordinate must not take
        // the pane — and must not burn two drops widening to the parent.
        let raw = r#"{
          "workspaces": [
            {
              "id": "ws-1",
              "name": "Keep me",
              "panes": [
                { "id": "p1", "x": "0", "y": 0.25, "w": 1.0, "h": 1.0,
                  "view": { "type": "TerminalView" } }
              ]
            }
          ]
        }"#;
        let recovered = deserialize_lenient(raw).unwrap();
        let pane = &recovered.settings.workspaces[0].panes[0];
        assert_eq!(pane.id, "p1");
        assert_eq!(pane.x, 0.0);
        assert_eq!(pane.y, 0.25);
        assert_eq!(recovered.dropped.len(), 1);
        assert_eq!(recovered.dropped[0].path, "workspaces[0].panes[0].x");
    }

    #[test]
    fn json_syntax_error_is_not_recoverable() {
        assert!(deserialize_lenient("{ not json").is_err());
    }

    #[test]
    fn non_object_root_is_not_recoverable() {
        // The document itself is the wrong shape. In particular an array must
        // not be salvaged: serde would read a struct in sequence form and
        // "recover" it into an empty settings object.
        assert!(deserialize_lenient("[1, 2, 3]").is_err());
        assert!(deserialize_lenient("\"just a string\"").is_err());
        assert!(deserialize_lenient("null").is_err());
        assert!(deserialize_lenient("42").is_err());
    }

    #[test]
    fn damage_far_beyond_a_hand_edit_still_recovers() {
        // 500 mistyped fields — well past anything a person types by hand, and
        // far past the old 64 cap that turned heavy damage into total loss.
        // Every one must be dropped individually, not escalated to ParseError.
        const BAD: usize = 500;
        let bad_profiles: Vec<String> = (0..BAD)
            .map(|i| format!(r#"{{ "name": "p{i}", "commandLine": {i} }}"#))
            .collect();
        let raw = format!(r#"{{ "profiles": [{}] }}"#, bad_profiles.join(","));

        let recovered = deserialize_lenient(&raw).expect("heavy damage must still recover");
        assert_eq!(recovered.settings.profiles.len(), BAD);
        assert_eq!(recovered.settings.profiles[0].name, "p0");
        assert_eq!(recovered.dropped.len(), BAD);
    }

    #[test]
    fn damage_past_the_bound_reports_the_file_as_unrecoverable() {
        // Past the bound there is no partial result to hand back — the tree
        // still does not parse — so the load must fail rather than loop.
        let bad_profiles: Vec<String> = (0..MAX_DROPPED_PATHS + 10)
            .map(|i| format!(r#"{{ "name": "p{i}", "commandLine": {i} }}"#))
            .collect();
        let raw = format!(r#"{{ "profiles": [{}] }}"#, bad_profiles.join(","));

        let err = deserialize_lenient(&raw).expect_err("must stop at the bound");
        assert!(err.contains("도달해"), "err: {err}");
    }
}
