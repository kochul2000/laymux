use serde::Serialize;

use crate::settings::models::{ColorScheme, FontSettings, Profile, Settings};

const DEFAULT_COLOR_SCHEME_NAME: &str = "CampbellClear";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTerminalAppearance {
    pub font_family: String,
    pub font_size: u16,
    pub cursor_style: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_width: Option<u16>,
    pub theme: RemoteTerminalTheme,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTerminalTheme {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub black: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub red: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub green: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yellow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magenta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cyan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub white: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_black: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_red: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_green: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_yellow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_blue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_magenta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_cyan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_white: Option<String>,
}

pub(super) fn resolve_remote_terminal_appearance(
    profile_name: &str,
    settings: &Settings,
) -> RemoteTerminalAppearance {
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.name == profile_name);
    let font = profile
        .and_then(|profile| profile.font.as_ref())
        .unwrap_or(&settings.profile_defaults.font);
    let cursor_shape = profile
        .and_then(|profile| non_empty(&profile.cursor_shape))
        .or_else(|| non_empty(&settings.profile_defaults.cursor_shape))
        .unwrap_or("bar");
    let (cursor_style, cursor_width) = xterm_cursor_options(cursor_shape);

    RemoteTerminalAppearance {
        font_family: terminal_font_family(font),
        font_size: if font.size == 0 {
            FontSettings::default().size
        } else {
            font.size
        },
        cursor_style: cursor_style.into(),
        cursor_width,
        theme: resolve_terminal_theme(profile, settings),
    }
}

fn terminal_font_family(font: &FontSettings) -> String {
    let face = non_empty(&font.face).unwrap_or("Cascadia Mono");
    let escaped_face = face.replace('\'', "\\'");
    format!("'{escaped_face}', 'Cascadia Mono', 'Consolas', monospace")
}

fn xterm_cursor_options(shape: &str) -> (&'static str, Option<u16>) {
    match shape {
        "bar" => ("bar", Some(1)),
        "underscore" => ("underline", None),
        "filledBox" => ("block", None),
        _ => ("block", None),
    }
}

fn resolve_terminal_theme(profile: Option<&Profile>, settings: &Settings) -> RemoteTerminalTheme {
    let scheme_name = profile
        .and_then(|profile| non_empty(&profile.color_scheme))
        .or_else(|| non_empty(&settings.profile_defaults.color_scheme))
        .unwrap_or(DEFAULT_COLOR_SCHEME_NAME);

    if let Some(scheme) = settings
        .color_schemes
        .iter()
        .find(|scheme| scheme.name == scheme_name)
    {
        return color_scheme_to_xterm_theme(&merge_with_default_color_scheme(scheme));
    }

    if scheme_name == DEFAULT_COLOR_SCHEME_NAME {
        return color_scheme_to_xterm_theme(&campbell_clear_color_scheme());
    }

    default_xterm_theme()
}

fn color_scheme_to_xterm_theme(scheme: &ColorScheme) -> RemoteTerminalTheme {
    let mut theme = default_xterm_theme();

    set_if_non_empty(&mut theme.foreground, &scheme.foreground);
    set_if_non_empty(&mut theme.background, &scheme.background);
    set_if_non_empty(&mut theme.cursor, &scheme.cursor_color);
    set_if_non_empty(
        &mut theme.selection_background,
        &scheme.selection_background,
    );
    set_if_non_empty(&mut theme.black, &scheme.black);
    set_if_non_empty(&mut theme.red, &scheme.red);
    set_if_non_empty(&mut theme.green, &scheme.green);
    set_if_non_empty(&mut theme.yellow, &scheme.yellow);
    set_if_non_empty(&mut theme.blue, &scheme.blue);
    set_if_non_empty(&mut theme.magenta, &scheme.purple);
    set_if_non_empty(&mut theme.cyan, &scheme.cyan);
    set_if_non_empty(&mut theme.white, &scheme.white);
    set_if_non_empty(&mut theme.bright_black, &scheme.bright_black);
    set_if_non_empty(&mut theme.bright_red, &scheme.bright_red);
    set_if_non_empty(&mut theme.bright_green, &scheme.bright_green);
    set_if_non_empty(&mut theme.bright_yellow, &scheme.bright_yellow);
    set_if_non_empty(&mut theme.bright_blue, &scheme.bright_blue);
    set_if_non_empty(&mut theme.bright_magenta, &scheme.bright_purple);
    set_if_non_empty(&mut theme.bright_cyan, &scheme.bright_cyan);
    set_if_non_empty(&mut theme.bright_white, &scheme.bright_white);

    theme
}

fn default_xterm_theme() -> RemoteTerminalTheme {
    RemoteTerminalTheme {
        background: Some("#0C0C0C".into()),
        foreground: Some("#F0F0F0".into()),
        cursor: Some("#FFFFFF".into()),
        selection_background: Some("#232042".into()),
        ..RemoteTerminalTheme::default()
    }
}

fn merge_with_default_color_scheme(scheme: &ColorScheme) -> ColorScheme {
    let default = default_color_scheme();
    ColorScheme {
        name: scheme.name.clone(),
        foreground: value_or_default(&scheme.foreground, &default.foreground),
        background: value_or_default(&scheme.background, &default.background),
        cursor_color: value_or_default(&scheme.cursor_color, &default.cursor_color),
        selection_background: value_or_default(
            &scheme.selection_background,
            &default.selection_background,
        ),
        black: value_or_default(&scheme.black, &default.black),
        red: value_or_default(&scheme.red, &default.red),
        green: value_or_default(&scheme.green, &default.green),
        yellow: value_or_default(&scheme.yellow, &default.yellow),
        blue: value_or_default(&scheme.blue, &default.blue),
        purple: value_or_default(&scheme.purple, &default.purple),
        cyan: value_or_default(&scheme.cyan, &default.cyan),
        white: value_or_default(&scheme.white, &default.white),
        bright_black: value_or_default(&scheme.bright_black, &default.bright_black),
        bright_red: value_or_default(&scheme.bright_red, &default.bright_red),
        bright_green: value_or_default(&scheme.bright_green, &default.bright_green),
        bright_yellow: value_or_default(&scheme.bright_yellow, &default.bright_yellow),
        bright_blue: value_or_default(&scheme.bright_blue, &default.bright_blue),
        bright_purple: value_or_default(&scheme.bright_purple, &default.bright_purple),
        bright_cyan: value_or_default(&scheme.bright_cyan, &default.bright_cyan),
        bright_white: value_or_default(&scheme.bright_white, &default.bright_white),
    }
}

fn default_color_scheme() -> ColorScheme {
    ColorScheme {
        name: String::new(),
        foreground: "#CCCCCC".into(),
        background: "#1E1E1E".into(),
        cursor_color: "#FFFFFF".into(),
        selection_background: "#264F78".into(),
        black: "#0C0C0C".into(),
        red: "#C50F1F".into(),
        green: "#13A10E".into(),
        yellow: "#C19C00".into(),
        blue: "#0037DA".into(),
        purple: "#881798".into(),
        cyan: "#3A96DD".into(),
        white: "#CCCCCC".into(),
        bright_black: "#767676".into(),
        bright_red: "#E74856".into(),
        bright_green: "#16C60C".into(),
        bright_yellow: "#F9F1A5".into(),
        bright_blue: "#3B78FF".into(),
        bright_purple: "#B4009E".into(),
        bright_cyan: "#61D6D6".into(),
        bright_white: "#F2F2F2".into(),
    }
}

fn campbell_clear_color_scheme() -> ColorScheme {
    ColorScheme {
        name: DEFAULT_COLOR_SCHEME_NAME.into(),
        foreground: "#F0F0F0".into(),
        background: "#0C0C0C".into(),
        cursor_color: "#FFFFFF".into(),
        selection_background: "#232042".into(),
        black: "#0C0C0C".into(),
        red: "#C50F1F".into(),
        green: "#13A10E".into(),
        yellow: "#C19C00".into(),
        blue: "#0037DA".into(),
        purple: "#881798".into(),
        cyan: "#3A96DD".into(),
        white: "#F0F0F0".into(),
        bright_black: "#767676".into(),
        bright_red: "#E74856".into(),
        bright_green: "#16C60C".into(),
        bright_yellow: "#F9F1A5".into(),
        bright_blue: "#3B78FF".into(),
        bright_purple: "#B4009E".into(),
        bright_cyan: "#61D6D6".into(),
        bright_white: "#FFFFFF".into(),
    }
}

fn set_if_non_empty(slot: &mut Option<String>, value: &str) {
    if let Some(value) = non_empty(value) {
        *slot = Some(value.into());
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn value_or_default(value: &str, default: &str) -> String {
    non_empty(value).unwrap_or(default).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherits_default_font_and_builtin_campbell_clear_theme() {
        let mut settings = Settings::default();
        settings.profile_defaults.font = FontSettings {
            face: "Fira Code".into(),
            size: 15,
            weight: "normal".into(),
        };
        settings.profiles = vec![Profile {
            name: "PowerShell".into(),
            font: None,
            ..Profile::default()
        }];

        let appearance = resolve_remote_terminal_appearance("PowerShell", &settings);

        assert_eq!(
            appearance.font_family,
            "'Fira Code', 'Cascadia Mono', 'Consolas', monospace"
        );
        assert_eq!(appearance.font_size, 15);
        assert_eq!(appearance.cursor_style, "bar");
        assert_eq!(appearance.cursor_width, Some(1));
        assert_eq!(appearance.theme.background.as_deref(), Some("#0C0C0C"));
        assert_eq!(appearance.theme.magenta.as_deref(), Some("#881798"));
        assert_eq!(appearance.theme.bright_white.as_deref(), Some("#FFFFFF"));
    }

    #[test]
    fn applies_profile_font_cursor_and_configured_color_scheme() {
        let mut scheme = default_color_scheme();
        scheme.name = "RemoteDark".into();
        scheme.foreground = "#111111".into();
        scheme.background = "#222222".into();
        scheme.cursor_color = "#333333".into();
        scheme.selection_background = "#444444".into();
        scheme.purple = "#555555".into();
        scheme.bright_purple = "#666666".into();

        let mut settings = Settings::default();
        settings.color_schemes = vec![scheme];
        settings.profiles = vec![Profile {
            name: "Custom".into(),
            color_scheme: "RemoteDark".into(),
            cursor_shape: "filledBox".into(),
            font: Some(FontSettings {
                face: "JetBrains Mono".into(),
                size: 18,
                weight: "normal".into(),
            }),
            ..Profile::default()
        }];

        let appearance = resolve_remote_terminal_appearance("Custom", &settings);

        assert_eq!(
            appearance.font_family,
            "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace"
        );
        assert_eq!(appearance.font_size, 18);
        assert_eq!(appearance.cursor_style, "block");
        assert_eq!(appearance.cursor_width, None);
        assert_eq!(appearance.theme.foreground.as_deref(), Some("#111111"));
        assert_eq!(appearance.theme.background.as_deref(), Some("#222222"));
        assert_eq!(appearance.theme.cursor.as_deref(), Some("#333333"));
        assert_eq!(
            appearance.theme.selection_background.as_deref(),
            Some("#444444")
        );
        assert_eq!(appearance.theme.magenta.as_deref(), Some("#555555"));
        assert_eq!(appearance.theme.bright_magenta.as_deref(), Some("#666666"));
    }

    #[test]
    fn maps_underscore_cursor_to_xterm_underline() {
        let mut settings = Settings::default();
        settings.profiles = vec![Profile {
            name: "PowerShell".into(),
            cursor_shape: "underscore".into(),
            ..Profile::default()
        }];

        let appearance = resolve_remote_terminal_appearance("PowerShell", &settings);

        assert_eq!(appearance.cursor_style, "underline");
        assert_eq!(appearance.cursor_width, None);
    }
}
