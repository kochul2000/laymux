use super::types::WorktreeEntry;
use crate::error::AppError;

pub(super) fn unsupported_nul(code: Option<i32>, stderr: &[u8]) -> bool {
    // The runner fixes LC_ALL=C. Only this option-parser error allows retry;
    // repository, permission, timeout and malformed-output errors remain errors.
    code == Some(129)
        && stderr
            .split(|byte| *byte == b'\n')
            .next()
            .is_some_and(|line| {
                line == b"error: unknown switch `z'" || line == b"error: unknown switch 'z'"
            })
}

fn invalid() -> AppError {
    AppError::Other("구버전 Git 워크트리 출력을 안전하게 해석할 수 없습니다. 개행이 포함된 경로는 Git 업그레이드가 필요합니다.".into())
}

pub(super) fn worktrees(bytes: &[u8]) -> Result<Vec<WorktreeEntry>, AppError> {
    if !bytes.ends_with(b"\n\n") || bytes.contains(&0) {
        return Err(invalid());
    }
    let mut nul = Vec::with_capacity(bytes.len());
    let mut seen = 0u8;
    // Git 2.34 writes worktree paths raw, including tabs and non-ASCII bytes.
    // Only reason fields use C quoting; quotePath does not quote those paths.
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        if line.is_empty() {
            if seen == 0 {
                return Err(invalid());
            }
            seen = 0;
            nul.push(0);
            continue;
        }
        let split = line.iter().position(|byte| *byte == b' ');
        let name = split.map_or(line, |index| &line[..index]);
        let flag = match name {
            b"worktree" => 1,
            b"HEAD" => 2,
            b"branch" => 4,
            b"detached" => 8,
            b"bare" => 16,
            b"locked" => 32,
            b"prunable" => 64,
            _ => return Err(invalid()),
        };
        if seen & flag != 0 || (flag == 1 && seen != 0) || (flag != 1 && seen == 0) {
            return Err(invalid());
        }
        seen |= flag;
        if seen & 12 == 12 || (seen & 16 != 0 && seen & 14 != 0) {
            return Err(invalid());
        }
        if matches!(name, b"locked" | b"prunable") {
            if let Some(index) = split {
                nul.extend_from_slice(&line[..=index]);
                nul.extend_from_slice(&unquote_reason(&line[index + 1..])?);
            } else {
                nul.extend_from_slice(line);
            }
        } else {
            nul.extend_from_slice(line);
        }
        nul.push(0);
    }
    super::parsing::worktrees(&nul).map_err(|_| invalid())
}

fn unquote_reason(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.first() != Some(&b'"') {
        return Ok(bytes.to_vec());
    }
    if bytes.len() < 2 || bytes.last() != Some(&b'"') {
        return Err(invalid());
    }
    let body = &bytes[1..bytes.len() - 1];
    let mut result = Vec::with_capacity(body.len());
    let mut index = 0;
    while index < body.len() {
        let mut byte = body[index];
        index += 1;
        if byte == b'"' {
            return Err(invalid());
        }
        if byte == b'\\' {
            byte = *body.get(index).ok_or_else(invalid)?;
            index += 1;
            byte = match byte {
                b'a' => 7,
                b'b' => 8,
                b'f' => 12,
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'v' => 11,
                b'\\' | b'"' => byte,
                b'0'..=b'3' => {
                    let rest = body.get(index..index + 2).ok_or_else(invalid)?;
                    if !rest.iter().all(|byte| matches!(byte, b'0'..=b'7')) {
                        return Err(invalid());
                    }
                    index += 2;
                    (byte - b'0') * 64 + (rest[0] - b'0') * 8 + (rest[1] - b'0')
                }
                _ => return Err(invalid()),
            };
        }
        if byte == 0 {
            return Err(invalid());
        }
        result.push(byte);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "de5e908943fd7e9eb0e7155b9bb126121635041b";

    #[test]
    fn fallback_is_only_for_the_unsupported_nul_switch() {
        assert!(unsupported_nul(
            Some(129),
            b"error: unknown switch `z'\nusage: git worktree list\n"
        ));
        assert!(!unsupported_nul(
            Some(128),
            b"fatal: not a git repository\n"
        ));
        assert!(!unsupported_nul(Some(129), b"error: unknown switch `x'\n"));
        assert!(!unsupported_nul(None, b"error: unknown switch `z'\n"));
    }

    #[test]
    fn old_git_raw_path_bytes_are_not_c_unquoted() {
        for path in [
            "/tmp/space name",
            "/tmp/tab\tname",
            "/tmp/back\\slash",
            "/tmp/한글",
            "/tmp/\"quoted\"",
            "/tmp/carriage\rname",
        ] {
            let output = format!("worktree {path}\nHEAD {HEAD}\nbranch refs/heads/main\n\n");
            let parsed = worktrees(output.as_bytes()).unwrap();
            assert_eq!(parsed[0].path, path);
        }
    }

    #[test]
    fn legacy_locked_reason_decodes_git_octal_and_c_escapes() {
        let reason =
            r#""locked \"quote\" \355\225\234\352\270\200\tTAB\nLINE\\backslash\a\b\f\r\v""#;
        let output = format!("worktree /tmp/main\nHEAD {HEAD}\nbranch refs/heads/main\n\nworktree /tmp/task\nHEAD {HEAD}\nbranch refs/heads/task\nlocked {reason}\n\n");
        let parsed = worktrees(output.as_bytes()).unwrap();
        assert_eq!(
            parsed[1].locked.as_deref(),
            Some("locked \"quote\" 한글\tTAB\nLINE\\backslash\u{7}\u{8}\u{c}\r\u{b}")
        );
        assert!(!parsed[1].is_main);
    }

    #[test]
    fn malformed_and_ambiguous_legacy_records_fail_closed() {
        for body in [
            format!("worktree /tmp/line\nname\nHEAD {HEAD}\nbranch refs/heads/main\n\n"),
            format!("worktree /tmp/main\nHEAD {HEAD}\nlocked \"unterminated\n\n"),
            format!("worktree /tmp/main\nHEAD {HEAD}\nlocked \"bad\\q\"\n\n"),
            format!("worktree /tmp/main\nHEAD {HEAD}\nlocked \"bad\\777\"\n\n"),
            format!("worktree /tmp/main\nHEAD {HEAD}\nlocked \"bad\\000\"\n\n"),
            format!("worktree /tmp/main\nHEAD {HEAD}\nbranch refs/heads/main\n"),
        ] {
            assert!(worktrees(body.as_bytes()).is_err(), "accepted {body:?}");
        }
    }
}
