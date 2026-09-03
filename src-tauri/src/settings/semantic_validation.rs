use std::collections::HashSet;
use std::net::IpAddr;

use crate::constants::{
    APP_THEME_IDS, COMPOSER_HISTORY_SCOPES, CONTROL_BAR_MODES, LINK_ACTIVATION_MODES,
    NOTIFICATION_DISMISS_MODES, PARSER_ADMISSION_SHARE_MAX, PARSER_ADMISSION_SHARE_MIN,
    PASTE_PATH_SEPARATORS, PROFILE_ANTIALIASING_MODES, PROFILE_BELL_STYLES,
    PROFILE_CLOSE_ON_EXIT_VALUES, PROFILE_CURSOR_SHAPES, SETTINGS_LANGUAGES,
    TERMINAL_ACTIVITY_WIDGET_SCOPES, UPDATE_CHANNELS, USAGE_WIDGET_BAR_HEIGHT_MAX,
    USAGE_WIDGET_BAR_HEIGHT_MIN, USAGE_WIDGET_BAR_WIDTH_MAX, USAGE_WIDGET_BAR_WIDTH_MIN,
    USAGE_WIDGET_DISPLAY_MODES, WIDGET_FONT_SIZE_MAX, WIDGET_FONT_SIZE_MIN, WIDGET_OVERFLOW_MODES,
    WIDGET_TYPES, WORKSPACE_LAST_INPUT_MODES, WORKSPACE_SORT_ORDERS,
};

use super::contract::SettingsIssue;
use super::models::{FontSettings, PaddingSettings, Profile, Settings, WidgetInstance};

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
        "/terminal/composerHistoryScope",
        &settings.terminal.composer_history_scope,
        COMPOSER_HISTORY_SCOPES,
    );
    // ADR-0224: 두 키는 프런트엔드가 소비하지만, 허용값 밖의 문자열은 여기서
    // 잡아야 사용자가 오타를 낸 채 "칩이 안 나온다"를 겪지 않는다.
    enum_value(
        &mut issues,
        "/terminal/urlLinkActivation",
        &settings.terminal.url_link_activation,
        LINK_ACTIVATION_MODES,
    );
    enum_value(
        &mut issues,
        "/terminal/pathLinkActivation",
        &settings.terminal.path_link_activation,
        LINK_ACTIVATION_MODES,
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
        "/update/channel",
        &settings.update.channel,
        UPDATE_CHANNELS,
    );
    enum_value(
        &mut issues,
        "/workspaceSelector/sortOrder",
        &settings.workspace_selector.sort_order,
        WORKSPACE_SORT_ORDERS,
    );
    enum_value(
        &mut issues,
        "/workspaceSelector/lastInputMode",
        &settings.workspace_selector.last_input_mode,
        WORKSPACE_LAST_INPUT_MODES,
    );

    validate_font(&mut issues, "/appearance/font", &settings.appearance.font);
    validate_profile_defaults(settings, &mut issues);
    validate_profiles(settings, &mut issues);
    validate_terminal(settings, &mut issues);
    validate_exit(settings, &mut issues);
    validate_pane_clear(settings, &mut issues);
    validate_agent_commands(settings, &mut issues);
    validate_remote(settings, &mut issues);
    validate_view_settings(settings, &mut issues);
    validate_widgets(settings, &mut issues);
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

/// Wheel multipliers are floats, and xterm rejects a non-positive one, so a
/// hand-edited value outside the supported band is reported rather than pushed
/// into the terminal. The running app clamps the same range.
fn range_scroll_sensitivity(issues: &mut Vec<SettingsIssue>, path: &str, value: f32) {
    if !value.is_finite()
        || !(crate::constants::MIN_SCROLL_SENSITIVITY..=crate::constants::MAX_SCROLL_SENSITIVITY)
            .contains(&value)
    {
        issue(
            issues,
            "out_of_range",
            path,
            format!(
                "{value}은(는) 허용 범위 {}..={} 밖입니다.",
                crate::constants::MIN_SCROLL_SENSITIVITY,
                crate::constants::MAX_SCROLL_SENSITIVITY
            ),
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
    range_scroll_sensitivity(
        issues,
        "/terminal/scrollSensitivity",
        settings.terminal.scroll_sensitivity,
    );
    range_scroll_sensitivity(
        issues,
        "/terminal/fastScrollSensitivity",
        settings.terminal.fast_scroll_sensitivity,
    );
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
    range_u64(
        issues,
        "/terminal/outputActivityBurst/volumeWindowMs",
        settings.terminal.output_activity_burst.volume_window_ms,
        100,
        super::models::MAX_VOLUME_WINDOW_MS,
    );
    range_u64(
        issues,
        "/terminal/outputActivityBurst/volumeThresholdBytes",
        settings
            .terminal
            .output_activity_burst
            .volume_threshold_bytes,
        super::models::MIN_VOLUME_THRESHOLD_BYTES,
        u64::MAX,
    );
    for (path, share) in [
        (
            "/terminal/parserAdmission/focusedShare",
            settings.terminal.parser_admission.focused_share,
        ),
        (
            "/terminal/parserAdmission/visibleShare",
            settings.terminal.parser_admission.visible_share,
        ),
        (
            "/terminal/parserAdmission/hiddenShare",
            settings.terminal.parser_admission.hidden_share,
        ),
    ] {
        range_u64(
            issues,
            path,
            u64::from(share),
            u64::from(PARSER_ADMISSION_SHARE_MIN),
            u64::from(PARSER_ADMISSION_SHARE_MAX),
        );
    }
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

fn validate_pane_clear(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    range_u64(
        issues,
        "/paneClear/interruptRounds",
        u64::from(settings.pane_clear.interrupt_rounds),
        1,
        10,
    );
    range_u64(
        issues,
        "/paneClear/settleMs",
        settings.pane_clear.settle_ms,
        0,
        10_000,
    );
}

/// The agent launch commands are typed into a shell, so a value carrying shell
/// metacharacters is reported instead of being executed — the running app falls
/// back to the bare `claude`/`codex` default.
fn validate_agent_commands(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    for (path, value) in [
        ("/claude/command", &settings.claude.command),
        ("/codex/command", &settings.codex.command),
        ("/grok/command", &settings.grok.command),
    ] {
        if !super::agent_command::is_safe_agent_command(value) {
            issue(
                issues,
                "invalid_value",
                path,
                format!(
                    "'{value}'은(는) 실행 명령으로 쓸 수 없습니다. 실행 파일 이름/경로와 플래그만 허용하며 셸 메타문자(; & | $ ` \" ' < >)와 줄바꿈은 쓸 수 없습니다. 이 값은 무시되고 기본 명령이 쓰입니다."
                ),
            );
        }
    }
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
    if !(1..=crate::settings::models::MAX_REMOTE_ATTACHMENT_MIB)
        .contains(&remote.attachment_max_mib)
    {
        issue(
            issues,
            "out_of_range",
            "/remote/attachmentMaxMib",
            format!(
                "attachmentMaxMib must be between 1 and {}.",
                crate::settings::models::MAX_REMOTE_ATTACHMENT_MIB
            ),
        );
    }
    for (index, extension) in remote.attachment_extra_extensions.iter().enumerate() {
        if !crate::remote_server::is_valid_attachment_extension(extension) {
            issue(
                issues,
                "invalid_value",
                format!("/remote/attachmentExtraExtensions/{index}"),
                format!(
                    "'{extension}'은(는) 유효한 확장자가 아닙니다. 점 없이 소문자 영문·숫자 1~16자만 허용합니다."
                ),
            );
        }
    }
    if remote.heartbeat_timeout_seconds < 30 {
        issue(
            issues,
            "out_of_range",
            "/remote/heartbeatTimeoutSeconds",
            "heartbeatTimeoutSeconds는 30 이상이어야 합니다.".into(),
        );
    }
    if remote.android_background_lease_seconds
        > crate::settings::models::MAX_ANDROID_BACKGROUND_LEASE_SECONDS
    {
        issue(
            issues,
            "out_of_range",
            "/remote/androidBackgroundLeaseSeconds",
            format!(
                "androidBackgroundLeaseSeconds must be between 0 and {}.",
                crate::settings::models::MAX_ANDROID_BACKGROUND_LEASE_SECONDS
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
    range_u64(
        issues,
        "/viewer/fontSize",
        u64::from(settings.viewer.font_size),
        8,
        32,
    );
}

fn optional_font_size(issues: &mut Vec<SettingsIssue>, path: &str, value: u16, min: u64, max: u64) {
    if value != 0 {
        range_u64(issues, path, u64::from(value), min, max);
    }
}

/// Check widget placement against the registry contract (ADR-0105).
///
/// Every issue reported here is about a value the write path must refuse, not a
/// value to repair: a placement this build cannot render is still the user's
/// placement, so loading keeps it and only rendering skips it.
fn validate_widgets(settings: &Settings, issues: &mut Vec<SettingsIssue>) {
    let widgets = &settings.widgets;
    range_u64(
        issues,
        "/widgets/fontSize",
        u64::from(widgets.font_size),
        WIDGET_FONT_SIZE_MIN,
        WIDGET_FONT_SIZE_MAX,
    );
    enum_value(
        issues,
        "/widgets/overflow",
        &widgets.overflow,
        WIDGET_OVERFLOW_MODES,
    );

    // `id` is unique across every slot, not per slot, so a widget keeps its
    // identity when the user moves it between the top bar and the status line.
    let mut seen_ids: HashSet<&str> = HashSet::new();
    let slots = [
        ("/widgets/topBar/left", &widgets.top_bar.left),
        ("/widgets/topBar/right", &widgets.top_bar.right),
        ("/widgets/statusLine/left", &widgets.status_line.left),
        ("/widgets/statusLine/right", &widgets.status_line.right),
    ];

    // The account picker offers the default dir plus whatever the user
    // registered, so a widget may not name anything else.
    let mut claude_config_dirs: Vec<&str> = vec![""];
    claude_config_dirs.extend(settings.usage.claude.config_dirs.iter().map(String::as_str));
    let mut grok_config_dirs: Vec<&str> = vec![""];
    grok_config_dirs.extend(settings.usage.grok.config_dirs.iter().map(String::as_str));

    for (slot_path, instances) in slots {
        for (index, instance) in instances.iter().enumerate() {
            let base = format!("{slot_path}/{index}");
            enum_value(
                issues,
                &format!("{base}/type"),
                &instance.widget_type,
                WIDGET_TYPES,
            );
            if instance.id.is_empty() {
                issue(
                    issues,
                    "invalid_value",
                    format!("{base}/id"),
                    "위젯 id 는 비어 있을 수 없습니다.".to_string(),
                );
            } else if !seen_ids.insert(instance.id.as_str()) {
                issue(
                    issues,
                    "duplicate_value",
                    format!("{base}/id"),
                    format!("위젯 id '{}'가 중복됩니다.", instance.id),
                );
            }
            validate_widget_options(
                issues,
                &base,
                instance,
                &claude_config_dirs,
                &grok_config_dirs,
            );
        }
    }
}

/// Validate the option domains this build knows.
///
/// Options a widget type does not declare are carried through untouched — the
/// backend refuses wrong values, not unfamiliar ones. A value that is present
/// but not a string is a wrong value, not an unfamiliar one: letting it through
/// would leave the frontend silently substituting a default the user never
/// chose, which is exactly what [ADR-0032] forbids.
///
/// [ADR-0032]: ../../../docs/adr/0032-llm-settings-introspection-and-safe-mutation.md
fn validate_widget_options(
    issues: &mut Vec<SettingsIssue>,
    base: &str,
    instance: &WidgetInstance,
    claude_config_dirs: &[&str],
    grok_config_dirs: &[&str],
) {
    if !instance.options.is_object() && !instance.options.is_null() {
        issue(
            issues,
            "type_error",
            format!("{base}/options"),
            "위젯 options 는 객체여야 합니다.".to_string(),
        );
        return;
    }

    let mut string_option = |key: &str, allowed: &[&str]| {
        let Some(value) = instance.options.get(key) else {
            return;
        };
        let path = format!("{base}/options/{key}");
        match value.as_str() {
            Some(text) => enum_value(issues, &path, text, allowed),
            None => issue(
                issues,
                "type_error",
                path,
                format!("위젯 옵션 '{key}' 는 문자열이어야 합니다."),
            ),
        }
    };

    match instance.widget_type.as_str() {
        "claudeUsage" => {
            string_option("display", USAGE_WIDGET_DISPLAY_MODES);
            string_option("configDir", claude_config_dirs);
        }
        "codexUsage" => string_option("display", USAGE_WIDGET_DISPLAY_MODES),
        "grokUsage" => {
            string_option("display", USAGE_WIDGET_DISPLAY_MODES);
            string_option("configDir", grok_config_dirs);
        }
        "terminalActivity" => string_option("scope", TERMINAL_ACTIVITY_WIDGET_SCOPES),
        _ => {}
    }

    if matches!(
        instance.widget_type.as_str(),
        "claudeUsage" | "codexUsage" | "grokUsage"
    ) {
        for key in ["barHeight", "elapsedHeight"] {
            let Some(value) = instance.options.get(key) else {
                continue;
            };
            let path = format!("{base}/options/{key}");
            match value.as_u64() {
                Some(height) => range_u64(
                    issues,
                    &path,
                    height,
                    USAGE_WIDGET_BAR_HEIGHT_MIN,
                    USAGE_WIDGET_BAR_HEIGHT_MAX,
                ),
                None => issue(
                    issues,
                    "type_error",
                    path,
                    format!("위젯 옵션 '{key}' 는 정수 픽셀 값이어야 합니다."),
                ),
            }
        }
        if let Some(value) = instance.options.get("barWidth") {
            let path = format!("{base}/options/barWidth");
            match value.as_u64() {
                Some(width) => range_u64(
                    issues,
                    &path,
                    width,
                    USAGE_WIDGET_BAR_WIDTH_MIN,
                    USAGE_WIDGET_BAR_WIDTH_MAX,
                ),
                None => issue(
                    issues,
                    "type_error",
                    path,
                    "위젯 옵션 'barWidth' 는 정수 픽셀 값이어야 합니다.".to_string(),
                ),
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_agent_launch_commands_produce_no_issue() {
        let mut settings = Settings::default();
        settings.claude.command = "claude --dangerously-skip-permissions".into();
        settings.codex.command = "codex --yolo".into();
        let issues = validate_settings(&settings);
        assert!(!issues.iter().any(|issue| issue.path.ends_with("/command")));
    }

    #[test]
    fn default_scroll_sensitivities_produce_no_issue() {
        let issues = validate_settings(&Settings::default());
        assert!(!issues
            .iter()
            .any(|issue| issue.path.ends_with("ScrollSensitivity")
                || issue.path.ends_with("/scrollSensitivity")));
    }

    #[test]
    fn invalid_workspace_last_input_mode_is_reported() {
        let mut settings = Settings::default();
        settings.workspace_selector.last_input_mode = "raw-output".into();
        let issues = validate_settings(&settings);
        assert!(issues
            .iter()
            .any(|issue| issue.path == "/workspaceSelector/lastInputMode"));
    }

    #[test]
    fn out_of_band_terminal_scroll_sensitivities_are_reported() {
        let mut settings = Settings::default();
        settings.terminal.scroll_sensitivity = 0.0;
        settings.terminal.fast_scroll_sensitivity = 50.0;

        let issues = validate_settings(&settings);
        let out_of_range: Vec<&str> = issues
            .iter()
            .filter(|issue| issue.code == "out_of_range")
            .map(|issue| issue.path.as_str())
            .collect();

        assert!(out_of_range.contains(&"/terminal/scrollSensitivity"));
        assert!(out_of_range.contains(&"/terminal/fastScrollSensitivity"));
    }

    #[test]
    fn update_channel_accepts_only_the_two_channels() {
        let mut settings = Settings::default();
        assert!(validate_settings(&settings)
            .iter()
            .all(|issue| issue.path != "/update/channel"));

        settings.update.channel = "beta".into();
        assert!(validate_settings(&settings)
            .iter()
            .all(|issue| issue.path != "/update/channel"));

        // A hand-edited channel is rejected on write. It is still tolerated on
        // read (resolving to stable at runtime), which is why the field is a
        // String rather than an enum (ADR-0190).
        settings.update.channel = "nightly".into();
        let issues = validate_settings(&settings);
        assert!(issues
            .iter()
            .any(|issue| issue.path == "/update/channel" && issue.code == "invalid_value"));
    }

    #[test]
    fn unsafe_agent_launch_commands_are_reported_per_agent() {
        let mut settings = Settings::default();
        settings.claude.command = "claude; rm -rf /".into();
        settings.codex.command = "".into();
        let issues = validate_settings(&settings);
        let paths: Vec<&str> = issues.iter().map(|issue| issue.path.as_str()).collect();
        assert!(paths.contains(&"/claude/command"));
        assert!(paths.contains(&"/codex/command"));
    }
}
