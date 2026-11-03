//! Bounded display-only user text from an already attributed agent transcript.
//! Never log message bodies or use them as task/clear authority.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

const READ_LIMIT: u64 = 1024 * 1024;
const TEXT_LIMIT: usize = 2048;

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubmittedAgentInput {
    pub text: String,
    pub timestamp: String,
}

impl std::fmt::Debug for SubmittedAgentInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubmittedAgentInput")
            .finish_non_exhaustive()
    }
}

impl SubmittedAgentInput {
    fn new(text: &str, timestamp: &Value) -> Option<Self> {
        let timestamp = match timestamp {
            Value::String(value) if value.len() <= 64 => value.clone(),
            Value::Number(value) => value.as_u64()?.to_string(),
            _ => return None,
        };
        let text: String = text.chars().take(TEXT_LIMIT).collect();
        (!text.trim().is_empty()).then_some(Self { text, timestamp })
    }
}

pub(super) fn codex_input(record: &Value) -> Option<SubmittedAgentInput> {
    if record["type"] != "event_msg" {
        return None;
    }
    let payload = &record["payload"];
    if payload["type"] == "user_message" {
        return SubmittedAgentInput::new(payload["message"].as_str()?, &record["timestamp"]);
    }
    // codex-rs/protocol/src/{items,user_input}.rs: completed UserMessage items.
    if payload["type"] != "item_completed" || payload["item"]["type"] != "UserMessage" {
        return None;
    }
    let text = payload["item"]["content"]
        .as_array()?
        .iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    SubmittedAgentInput::new(&text, &record["timestamp"])
}

#[derive(Clone, Copy)]
pub(super) enum Provider {
    Claude,
    Grok,
}

pub(super) fn read_last_input(
    path: &Path,
    provider: Provider,
    session_id: &str,
) -> Option<SubmittedAgentInput> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(READ_LIMIT);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(len - start).read_to_end(&mut bytes).ok()?;
    last_input(&bytes, start > 0, provider, session_id)
}

fn last_input(
    bytes: &[u8],
    truncated: bool,
    provider: Provider,
    session_id: &str,
) -> Option<SubmittedAgentInput> {
    let end = bytes.iter().rposition(|&b| b == b'\n')?;
    let mut lines: Vec<_> = bytes[..end].split(|&b| b == b'\n').collect();
    if truncated && !lines.is_empty() {
        lines.remove(0);
    }
    let mut grok: Option<(u64, SubmittedAgentInput)> = None;
    let mut complete_group = !truncated;
    for line in lines.into_iter().rev() {
        if line.is_empty() {
            continue;
        }
        let record: Value = serde_json::from_slice(line).ok()?;
        match provider {
            Provider::Claude => {
                if record["type"] != "user"
                    || record["isSidechain"] == true
                    || record["isMeta"] == true
                    || record["isCompactSummary"] == true
                {
                    continue;
                }
                if record["sessionId"].as_str() != Some(session_id)
                    || record["message"]["role"] != "user"
                {
                    return None;
                }
                let content = &record["message"]["content"];
                let text = if let Some(text) = content.as_str() {
                    text.to_owned()
                } else {
                    let blocks = content.as_array()?;
                    if blocks.iter().any(|block| block["type"] == "tool_result") {
                        continue;
                    }
                    blocks
                        .iter()
                        .filter(|block| block["type"] == "text")
                        .filter_map(|block| block["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return SubmittedAgentInput::new(&text, &record["timestamp"]);
            }
            Provider::Grok => {
                if record["params"]["sessionId"].as_str() != Some(session_id) {
                    return None;
                }
                let update = &record["params"]["update"];
                if update["sessionUpdate"] != "user_message_chunk" {
                    continue;
                }
                let index = update["_meta"]["promptIndex"].as_u64()?;
                if grok
                    .as_ref()
                    .is_some_and(|(previous, _)| *previous != index)
                {
                    complete_group = true;
                    break;
                }
                if update["content"]["type"] != "text" {
                    return None;
                }
                let input = SubmittedAgentInput::new(
                    update["content"]["text"].as_str()?,
                    &record["timestamp"],
                )?;
                if let Some((_, previous)) = &mut grok {
                    previous.text = input
                        .text
                        .chars()
                        .chain(previous.text.chars())
                        .take(TEXT_LIMIT)
                        .collect();
                    previous.timestamp = input.timestamp;
                } else {
                    grok = Some((index, input));
                }
            }
        }
    }
    // A cut-off Grok chunk group cannot prove its beginning.
    if complete_group {
        grok.map(|(_, input)| input)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_reads_only_submitted_user_text_and_bounds_it() {
        let record = json!({"type":"event_msg","timestamp":"2026-11-03T00:00:00.123Z","payload":{"type":"user_message","message":"가".repeat(3000)}});
        assert_eq!(
            codex_input(&record).unwrap().text.chars().count(),
            TEXT_LIMIT
        );
        assert!(codex_input(
            &json!({"type":"event_msg","payload":{"type":"agent_message","message":"answer"}})
        )
        .is_none());
        let current = json!({"type":"event_msg","timestamp":"2026-11-03T00:00:00.123Z","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"@completed/path"},{"type":"local_image","path":"ignored"}]}}});
        assert_eq!(codex_input(&current).unwrap().text, "@completed/path");
    }

    #[test]
    fn claude_skips_tool_results_meta_sidechains_and_partial_records() {
        let input = json!({"type":"user","sessionId":"s","timestamp":"2026-11-03T00:00:00.123Z","message":{"role":"user","content":[{"type":"text","text":"@completed/path"}]}});
        let tool = json!({"type":"user","sessionId":"s","message":{"role":"user","content":[{"type":"tool_result","content":"not input"}]}});
        let meta = json!({"type":"user","isMeta":true,"message":{"content":"not input"}});
        let bytes = format!("{input}\n{tool}\n{meta}\n{{partial");
        assert_eq!(
            last_input(bytes.as_bytes(), false, Provider::Claude, "s")
                .unwrap()
                .text,
            "@completed/path"
        );
        assert!(last_input(bytes.as_bytes(), false, Provider::Claude, "other").is_none());
    }

    #[test]
    fn grok_joins_only_the_latest_prompt_chunks() {
        let chunk = |index, text| json!({"timestamp":1793664000123_u64,"params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","_meta":{"promptIndex":index},"content":{"type":"text","text":text}}}});
        let bytes = format!(
            "{}\n{}\n{}\n",
            chunk(0, "old"),
            chunk(1, "@completed/"),
            chunk(1, "path")
        );
        assert_eq!(
            last_input(bytes.as_bytes(), false, Provider::Grok, "s")
                .unwrap()
                .text,
            "@completed/path"
        );
        assert!(last_input(bytes.as_bytes(), true, Provider::Grok, "s").is_none());
        let tail = format!("partial\n{bytes}");
        assert!(last_input(tail.as_bytes(), true, Provider::Grok, "s").is_some());
    }
}
