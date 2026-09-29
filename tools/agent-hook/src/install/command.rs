use super::{config_name, helper_path};
use serde_json::{json, Value};
use std::path::Path;

pub fn handler(root: &Path, provider: &str) -> Result<Value, String> {
    config_name(provider)?;
    let executable = helper_path(root);
    let path = executable.to_str().ok_or("Invalid helper path")?;
    #[cfg(windows)]
    {
        let literal = path.replace('/', "\\").replace('\'', "''");
        if provider == "claude" {
            return Ok(json!({"type":"command", "shell":"powershell",
                "command":format!("& '{literal}' emit {provider}"), "timeout":3}));
        }
        // Codex's default Windows hook shell is cmd /C. Keep percent signs out
        // of that outer shell's expansion without encoding the readable path.
        let literal = literal.replace('%', "' + [char]37 + '");
        Ok(json!({"type":"command",
            "command":format!("powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command \"& ('{literal}') emit {provider}\""), "timeout":3}))
    }
    #[cfg(not(windows))]
    Ok(json!({"type":"command",
        "command":format!("'{}' emit {provider}", path.replace('\'', "'\\''")), "timeout":3}))
}

pub(super) struct OwnedHandlers {
    pub current: Value,
    #[cfg(windows)]
    legacy: Value,
}

impl OwnedHandlers {
    pub fn new(root: &Path, provider: &str) -> Result<Self, String> {
        Ok(Self {
            current: handler(root, provider)?,
            #[cfg(windows)]
            legacy: {
                use base64::Engine;
                let executable = helper_path(root);
                let path = executable
                    .to_str()
                    .ok_or("Invalid helper path")?
                    .replace('/', "\\");
                let script = format!("& '{}' emit {provider}", path.replace('\'', "''"));
                let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
                // Recognition only: this exact historical command is never installed.
                json!({"type":"command", "command":format!("powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(bytes))})
            },
        })
    }

    pub fn matches(&self, candidate: &Value) -> bool {
        let same = |owned: &Value| {
            [
                "type",
                "command",
                "args",
                "shell",
                "commandWindows",
                "command_windows",
            ]
            .iter()
            .all(|key| candidate.get(*key) == owned.get(*key))
        };
        if same(&self.current) {
            return true;
        }
        #[cfg(windows)]
        if same(&self.legacy) {
            return true;
        }
        false
    }
}
