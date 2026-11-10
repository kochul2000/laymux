use super::output::OUTPUT_LIMIT;
use super::types::{WorktreeEntry, WorktreeFile};
use crate::error::AppError;
use std::io::{BufRead, BufReader, Read};

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

fn record(reader: &mut impl BufRead, buffer: &mut Vec<u8>) -> Result<bool, AppError> {
    buffer.clear();
    let size = Read::take(reader, (OUTPUT_LIMIT + 1) as u64).read_until(0, buffer)?;
    if size == 0 {
        return Ok(false);
    }
    if size > OUTPUT_LIMIT || buffer.last() != Some(&0) {
        return Err(invalid());
    }
    buffer.pop();
    Ok(true)
}

pub(super) fn status(source: impl Read) -> Result<FileStatus, AppError> {
    let mut reader = BufReader::new(source);
    let mut buffer = Vec::new();
    let mut result = FileStatus::default();
    let mut preview_bytes = 0;
    while record(&mut reader, &mut buffer)? {
        let field = std::str::from_utf8(&buffer).map_err(|_| invalid())?;
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
                "tracked"
            }
            _ => return Err(invalid()),
        };
        let renamed = raw[..2].contains(&b'R') || raw[..2].contains(&b'C');
        if result.files.len() < FILE_PREVIEW_LIMIT
            && preview_bytes + field[3..].len() <= OUTPUT_LIMIT
        {
            preview_bytes += field[3..].len();
            result.files.push(WorktreeFile {
                kind: kind.into(),
                path: field[3..].into(),
            });
        }
        if renamed {
            if !record(&mut reader, &mut buffer)? || buffer.is_empty() {
                return Err(invalid());
            }
            std::str::from_utf8(&buffer).map_err(|_| invalid())?;
        }
    }
    Ok(result)
}

/// `-v --stage` prefixes each index entry with its visibility tag and mode.
pub(super) fn index_guards(source: impl Read) -> Result<(bool, bool), AppError> {
    let mut reader = BufReader::new(source);
    let mut buffer = Vec::new();
    let mut submodules = false;
    let mut hidden = false;
    while record(&mut reader, &mut buffer)? {
        let record = &buffer;
        if record.is_empty() {
            continue;
        }
        if record.len() < 10 || record[1] != b' ' || record[8] != b' ' {
            return Err(invalid());
        }
        submodules |= &record[2..8] == b"160000";
        hidden |= record[0].is_ascii_lowercase() || record[0] == b'S';
    }
    Ok((submodules, hidden))
}
