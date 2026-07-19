use std::collections::HashSet;
use std::net::IpAddr;

use crate::constants::{
    APP_THEME_IDS, CONTROL_BAR_MODES, NOTIFICATION_DISMISS_MODES, PASTE_PATH_SEPARATORS,
    PROFILE_ANTIALIASING_MODES, PROFILE_BELL_STYLES, PROFILE_CLOSE_ON_EXIT_VALUES,
    PROFILE_CURSOR_SHAPES, SETTINGS_LANGUAGES, TERMINAL_SCROLLBAR_STYLES, WORKSPACE_SORT_ORDERS,
};

use super::contract::SettingsIssue;
use super::models::{FontSettings, PaddingSettings, Profile, Settings};

pub fn validate_settings(settings: &Settings) -> Vec<SettingsIssue> {
    let mut issues = Vec::new();

    enum_value(
        &mut issues,
        "/language",
        &settings.language,
        SETTINGS_LANGUAGES,
    );
    enum_value(
        &mut issues,
        "/appearance/themeId",
        &settings.appearance.theme_id,
        APP_THEME_IDS,
    );
    enum_value(
        &mut issues,
        "/terminal/scrollbarStyle",
        &settings.terminal.scrollbar_style,
        TERMINAL_SCROLLBAR_STYLES,
    );
    enum_value(
        &mut issues,
        "/paste/pathSeparator",
        &settings.paste.path_separator,
        PASTE_PATH_SEPARATORS,
    );
    enum_value(
        &mut issues,
        "/controlBar/defaultMode",
        &settings.control_bar.default_mode,
        CONTROL_BAR_MODES,
    );
    enum_value(
        &mut issues,
        "/notifications/dismiss",
        &settings.notifications.dismiss,
        NOTIFICATION_DISMISS_MODES,
    );
    enum_value(
        &mut issues,
        "/workspaceSelector/sortOrder",
        &settings.workspace_selector.sort_order,
        WORKSPACE_SORT_ORDERS,
    );

    validate_font(&mut issues, "/appearance/font", &settings.appearance.font);
    validate_profile_defaults(settings, &mut issues);
    validate_profiles(settings, &mut issues);
    validate_terminal(settings, &mut issues);
    validate_exit(settings, &mut issues);
    validate_remote(settings, &mut issues);
    validate_view_settings(settings, &mut issues);
    validate_extension_viewers(settings, &mut issues);
    validate_workspace_profile_references(settings, &mut issues);

    issues
}

fn issue(issues: &mut Vec<SettingsIssue>, code: &str, path: impl Into<String>, message: String) {
    issues.push(SettingsIssue {
        code: code.to_string(),
        path: path.into(),
        message,
    });
}

fn enum_value(issues: &mut Vec<SettingsIssue>, path: &str, value: &str, allowed: &[&str]) {
    if !allowed.contains(&value) {
        issue(
            issues,
            "invalid_value",
            path,
            format!(
                "'{value}'은(는) 허용값이 아닙니다. 허용값: {}",
                allowed.join(", ")
            ),
        );
    }
}

fn range_u64(issues: &mut Vec<SettingsIssue>, path: &str, value: u64, min: u64, max: u64) {
    if !(min..=max).contains(&value) {
        issue(
            issues,
            "out_of_range",
            path,
            format!("{value}은(는) 허용 범위 {min}..={max} 밖입니다."),
        );
    }
}

fn validate_font(issues: &mut Vec<SettingsIssue>, path: &str, font: &FontSettings) {
    range_u64(issues, &format!("{path}/size"), u64::from(font.size), 6, 72);
    if font.face.trim().is_empty() {
        issue(
            issues,
            "required",
            format!("{path}/face"),
            "폰트 이름은 비어 있을 수 없습니다.".into(),
        );
    }
}

fn validate_padding(issues: &mut Vec<SettingsIssue>, path: &str, padding: &PaddingSettings) {
    for (name, value) in [
        ("top", padding.top),
        ("right", padding.right),
        ("bottom", padding.bottom),
        ("left", padding.left),
    ] {
        range_u64(issues, &format!("{path}/{name}"), u64::from(value), 0, 100);
    }
}

fn validate_profile_defaults(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    let defaults = &settings.profile_defaults;
    validate_profile_enums(
        issues,
        "/profileDefaults",
        &defaults.cursor_shape,
        &defaults.bell_style,
        &defaults.close_on_exit,
        &defaults.antialiasing_mode,
    );
    validate_padding(issues, "/profileDefaults/padding", &defaults.padding);
    validate_font(issues, "/profileDefaults/font", &defaults.font);
    range_u64(
        issues,
        "/profileDefaults/opacity",
        u64::from(defaults.opacity),
        10,
        100,
    );
    range_u64(
        issues,
        "/profileDefaults/scrollbackLines",
        u64::from(defaults.scrollback_lines),
        0,
        999_999,
    );
    if defaults.max_output_cache_kb == 0 {
        issue(
            issues,
            "out_of_range",
            "/profileDefaults/maxOutputCacheKB",
            "출력 캐시 크기는 1KiB 이상이어야 합니다.".into(),
        );
    }
}

fn validate_profiles(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    if settings.profiles.is_empty() {
        issue(
            issues,
            "required",
            "/profiles",
            "프로필은 하나 이상 있어야 합니다.".into(),
        );
        return;
    }

    let mut names = HashSet::new();
    for (index, profile) in settings.profiles.iter().enumerate() {
        let path = format!("/profiles/{index}");
        if profile.name.trim().is_empty() {
            issue(
                issues,
                "required",
                format!("{path}/name"),
                "프로필 이름은 비어 있을 수 없습니다.".into(),
            );
        } else if !names.insert(profile.name.as_str()) {
            issue(
                issues,
                "duplicate",
                format!("{path}/name"),
                format!("프로필 이름 '{}'이(가) 중복됩니다.", profile.name),
            );
        }
        validate_profile(issues, &path, profile);
    }

    if !settings.default_profile.is_empty()
        && !settings
            .profiles
            .iter()
            .any(|profile| profile.name == settings.default_profile)
    {
        issue(
            issues,
            "invalid_reference",
            "/defaultProfile",
            format!(
                "프로필 '{}'이(가) 존재하지 않습니다.",
                settings.default_profile
            ),
        );
    }
}

fn validate_profile(issues: &mut Vec<SettingsIssue>, path: &str, profile: &Profile) {
    validate_profile_enums(
        issues,
        path,
        &profile.cursor_shape,
        &profile.bell_style,
        &profile.close_on_exit,
        &profile.antialiasing_mode,
    );
    validate_padding(issues, &format!("{path}/padding"), &profile.padding);
    range_u64(
        issues,
        &format!("{path}/opacity"),
        u64::from(profile.opacity),
        10,
        100,
    );
    range_u64(
        issues,
        &format!("{path}/scrollbackLines"),
        u64::from(profile.scrollback_lines),
        0,
        999_999,
    );
    if let Some(font) = &profile.font {
        validate_font(issues, &format!("{path}/font"), font);
    }
}

fn validate_profile_enums(
    issues: &mut Vec<SettingsIssue>,
    path: &str,
    cursor_shape: &str,
    bell_style: &str,
    close_on_exit: &str,
    antialiasing_mode: &str,
) {
    enum_value(
        issues,
        &format!("{path}/cursorShape"),
        cursor_shape,
        PROFILE_CURSOR_SHAPES,
    );
    enum_value(
        issues,
        &format!("{path}/bellStyle"),
        bell_style,
        PROFILE_BELL_STYLES,
    );
    enum_value(
        issues,
        &format!("{path}/closeOnExit"),
        close_on_exit,
        PROFILE_CLOSE_ON_EXIT_VALUES,
    );
    enum_value(
        issues,
        &format!("{path}/antialiasingMode"),
        antialiasing_mode,
        PROFILE_ANTIALIASING_MODES,
    );
}

fn validate_terminal(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    range_u64(
        issues,
        "/terminal/pathLinkMaxLength",
        u64::from(settings.terminal.path_link_max_length),
        8,
        4096,
    );
    range_u64(
        issues,
        "/terminal/outputActivityBurst/windowMs",
        settings.terminal.output_activity_burst.window_ms,
        100,
        u64::MAX,
    );
    range_u64(
        issues,
        "/terminal/outputActivityBurst/threshold",
        settings.terminal.output_activity_burst.threshold,
        2,
        u64::MAX,
    );
    range_u64(
        issues,
        "/terminal/outputActivityBurst/throttleMs",
        settings.terminal.output_activity_burst.throttle_ms,
        100,
        u64::MAX,
    );
}

fn validate_exit(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    range_u64(
        issues,
        "/exit/interruptRounds",
        u64::from(settings.exit.interrupt_rounds),
        1,
        10,
    );
    range_u64(issues, "/exit/settleMs", settings.exit.settle_ms, 0, 10_000);
}

fn validate_remote(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    let remote = &settings.remote;
    if remote.enabled && remote.auth_token.trim().is_empty() {
        issue(
            issues,
            "required",
            "/remote/authToken",
            "remote.enabled=true이면 authToken이 필요합니다.".into(),
        );
    }
    if remote.heartbeat_timeout_seconds < 30 {
        issue(
            issues,
            "out_of_range",
            "/remote/heartbeatTimeoutSeconds",
            "heartbeatTimeoutSeconds는 30 이상이어야 합니다.".into(),
        );
    }
    if !(crate::constants::MIN_REMOTE_SNAPSHOT_MAX_KIB
        ..=crate::constants::MAX_REMOTE_SNAPSHOT_MAX_KIB)
        .contains(&remote.snapshot_max_kib)
    {
        issue(
            issues,
            "out_of_range",
            "/remote/snapshotMaxKib",
            format!(
                "snapshotMaxKib는 {}~{} 범위여야 합니다.",
                crate::constants::MIN_REMOTE_SNAPSHOT_MAX_KIB,
                crate::constants::MAX_REMOTE_SNAPSHOT_MAX_KIB
            ),
        );
    }
    for (index, entry) in remote.allowed_ips.iter().enumerate() {
        if !is_valid_ip_or_cidr(entry) {
            issue(
                issues,
                "invalid_value",
                format!("/remote/allowedIps/{index}"),
                format!("'{entry}'은(는) 유효한 IP/CIDR 또는 *가 아닙니다."),
            );
        }
    }
    for (index, origin) in remote.allowed_origins.iter().enumerate() {
        let valid = reqwest::Url::parse(origin).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && (url.path().is_empty() || url.path() == "/")
                && url.query().is_none()
                && url.fragment().is_none()
        });
        if !valid {
            issue(
                issues,
                "invalid_value",
                format!("/remote/allowedOrigins/{index}"),
                format!("'{origin}'은(는) 유효한 http(s) Origin이 아닙니다."),
            );
        }
    }
}

fn is_valid_ip_or_cidr(raw: &str) -> bool {
    let entry = raw.trim();
    if entry == "*" || entry.parse::<IpAddr>().is_ok() {
        return true;
    }
    let Some((network, prefix)) = entry.split_once('/') else {
        return false;
    };
    let Ok(network) = network.parse::<IpAddr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    match network {
        IpAddr::V4(_) => prefix <= 32,
        IpAddr::V6(_) => prefix <= 128,
    }
}

fn validate_view_settings(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    range_u64(
        issues,
        "/memo/indentSize",
        u64::from(settings.memo.indent_size),
        1,
        8,
    );
    range_u64(
        issues,
        "/memo/paragraphCopy/minBlankLines",
        u64::from(settings.memo.paragraph_copy.min_blank_lines),
        1,
        10,
    );
    optional_font_size(issues, "/memo/fontSize", settings.memo.font_size, 6, 72);
    optional_font_size(
        issues,
        "/issueReporter/fontSize",
        settings.issue_reporter.font_size,
        6,
        72,
    );
    range_u64(
        issues,
        "/fileExplorer/fontSize",
        u64::from(settings.file_explorer.font_size),
        8,
        32,
    );
}

fn optional_font_size(issues: &mut Vec<SettingsIssue>, path: &str, value: u16, min: u64, max: u64) {
    if value != 0 {
        range_u64(issues, path, u64::from(value), min, max);
    }
}

fn validate_extension_viewers(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    let profile_names: HashSet<&str> = settings
        .profiles
        .iter()
        .map(|profile| profile.name.as_str())
        .collect();
    for (index, viewer) in settings.file_explorer.extension_viewers.iter().enumerate() {
        let path = format!("/fileExplorer/extensionViewers/{index}");
        if viewer.extensions.is_empty() {
            issue(
                issues,
                "required",
                format!("{path}/extensions"),
                "확장자는 하나 이상 있어야 합니다.".into(),
            );
        }
        for (extension_index, extension) in viewer.extensions.iter().enumerate() {
            if !extension.starts_with('.') || extension.len() < 2 {
                issue(
                    issues,
                    "invalid_value",
                    format!("{path}/extensions/{extension_index}"),
                    format!("'{extension}'은(는) 점으로 시작하는 확장자가 아닙니다."),
                );
            }
        }
        if viewer.command.trim().is_empty() {
            issue(
                issues,
                "required",
                format!("{path}/command"),
                "viewer command는 비어 있을 수 없습니다.".into(),
            );
        }
        if !profile_names.contains(viewer.profile.as_str()) {
            issue(
                issues,
                "invalid_reference",
                format!("{path}/profile"),
                format!("프로필 '{}'이(가) 존재하지 않습니다.", viewer.profile),
            );
        }
    }
}

fn validate_workspace_profile_references(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    let profile_names: HashSet<&str> = settings
        .profiles
        .iter()
        .map(|profile| profile.name.as_str())
        .collect();
    for (workspace_index, workspace) in settings.workspaces.iter().enumerate() {
        for (pane_index, pane) in workspace.panes.iter().enumerate() {
            if pane.view.view_type != "TerminalView" {
                continue;
            }
            let Some(profile) = pane
                .view
                .extra
                .get("profile")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            if !profile.is_empty() && !profile_names.contains(profile) {
                issue(
                    issues,
                    "invalid_reference",
                    format!("/workspaces/{workspace_index}/panes/{pane_index}/view/profile"),
                    format!("프로필 '{profile}'이(가) 존재하지 않습니다."),
                );
            }
        }
    }
}
