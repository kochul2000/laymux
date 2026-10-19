use super::types::{WorktreeEntry, WorktreeFile};
use crate::error::AppError;

pub(super) const FILE_PREVIEW_LIMIT: usize = 200;

fn invalid() -> AppError {
    AppError::Other("Git 출력 형식을 확인할 수 없습니다.".into())
}

pub(super) fn worktrees(bytes: &[u8]) -> Result<Vec<WorktreeEntry>, AppError> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    if !text.ends_with("\0\0") {
        return Err(invalid());
    }
    let mut result = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in text.split('\0') {
        if field.is_empty() {
            if let Some(entry) = current.take() {
                if !entry.bare && entry.head.is_empty() {
                    return Err(invalid());
                }
                result.push(entry);
            }
            continue;
        }
        let (name, value) = field.split_once(' ').unwrap_or((field, ""));
        if name == "worktree" {
            if current.is_some() || value.is_empty() {
                return Err(invalid());
            }
            current = Some(WorktreeEntry {
                path: value.to_owned(),
                head: String::new(),
                branch: None,
                is_main: result.is_empty(),
                bare: false,
                locked: None,
                prunable: None,
            });
            continue;
        }
        let entry = current.as_mut().ok_or_else(invalid)?;
        match name {
            "HEAD" => entry.head = value.to_owned(),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .ok_or_else(invalid)?
                        .to_owned(),
                )
            }
            "bare" => entry.bare = true,
            "locked" => entry.locked = Some(value.to_owned()),
            "prunable" => entry.prunable = Some(value.to_owned()),
            "detached" => {}
            _ => return Err(invalid()),
        }
    }
    if result.is_empty() {
        return Err(invalid());
    }
    Ok(result)
}

#[derive(Default)]
pub(super) struct FileStatus {
    pub tracked: usize,
    pub untracked: usize,
    pub ignored: usize,
    pub files: Vec<WorktreeFile>,
}

pub(super) fn status(bytes: &[u8]) -> Result<FileStatus, AppError> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) {
        return Err(invalid());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut fields = text.split_terminator('\0');
    let mut result = FileStatus::default();
    while let Some(field) = fields.next() {
        let raw = field.as_bytes();
        if raw.len() < 4 || raw[2] != b' ' {
            return Err(invalid());
        }
        let kind = match &raw[..2] {
            b"??" => {
                result.untracked += 1;
                "untracked"
            }
            b"!!" => {
                result.ignored += 1;
                "ignored"
            }
            code if code.iter().all(|byte| b" MADRCUT".contains(byte)) => {
                result.tracked += 1;
                if code.contains(&b'R') || code.contains(&b'C') {
                    if fields.next().is_none_or(str::is_empty) {
                        return Err(invalid());
                    }
                }
                "tracked"
            }
            _ => return Err(invalid()),
        };
        if result.files.len() < FILE_PREVIEW_LIMIT {
            result.files.push(WorktreeFile {
                kind: kind.into(),
                path: field[3..].into(),
            });
        }
    }
    Ok(result)
}

/// `-v --stage` prefixes each index entry with its visibility tag and mode.
pub(super) fn index_guards(bytes: &[u8]) -> Result<(bool, bool), AppError> {
    let mut submodules = false;
    let mut hidden = false;
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 10 || record[1] != b' ' || record[8] != b' ' {
            return Err(invalid());
        }
        submodules |= &record[2..8] == b"160000";
        hidden |= record[0].is_ascii_lowercase() || record[0] == b'S';
    }
    Ok((submodules, hidden))
}
