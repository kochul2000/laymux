//! Shared memo writes compare and commit under the same gate as desktop writes.
use std::collections::HashMap;
use std::path::PathBuf;

use super::{lock_memo_gate, memo_path, save_memo_to, MEMO_LOCK};

#[derive(Debug)]
pub enum MemoWriteError {
    Conflict,
    Storage(String),
}

fn read_strict(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    match std::fs::read_to_string(path) {
        Ok(data) => serde_json::from_str(&data).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn load_shared_memos() -> Result<HashMap<String, String>, String> {
    let _guard = lock_memo_gate(&MEMO_LOCK)?;
    read_strict(&memo_path())
}

pub fn save_shared_memo(key: &str, content: &str, expected: &str) -> Result<(), MemoWriteError> {
    let _guard = lock_memo_gate(&MEMO_LOCK).map_err(MemoWriteError::Storage)?;
    compare_and_save(&memo_path(), key, content, expected)
}

fn compare_and_save(
    path: &PathBuf,
    key: &str,
    content: &str,
    expected: &str,
) -> Result<(), MemoWriteError> {
    let memos = read_strict(path).map_err(MemoWriteError::Storage)?;
    let current = memos.get(key).map(String::as_str).unwrap_or_default();
    // An exact retry after a lost response is safe and idempotent.
    if current == content {
        return Ok(());
    }
    if current != expected {
        return Err(MemoWriteError::Conflict);
    }
    save_memo_to(path, key, content).map_err(MemoWriteError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_memo_conflict_preserves_pc_content_and_other_memos() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        compare_and_save(&path, "memo-a", "PC", "").unwrap();
        compare_and_save(&path, "memo-b", "other", "").unwrap();
        assert!(matches!(
            compare_and_save(&path, "memo-a", "phone", ""),
            Err(MemoWriteError::Conflict)
        ));
        assert_eq!(read_strict(&path).unwrap()["memo-a"], "PC");
        compare_and_save(&path, "memo-a", "phone", "PC").unwrap();
        compare_and_save(&path, "memo-a", "phone", "PC").unwrap();
        assert_eq!(read_strict(&path).unwrap()["memo-b"], "other");
        compare_and_save(&path, "memo-a", "", "phone").unwrap();
        assert!(!read_strict(&path).unwrap().contains_key("memo-a"));
    }

    #[test]
    fn shared_memo_corruption_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        std::fs::write(&path, "broken").unwrap();
        assert!(matches!(
            compare_and_save(&path, "memo-a", "new", ""),
            Err(MemoWriteError::Storage(_))
        ));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
    }

    #[test]
    fn shared_memo_failed_staging_preserves_saved_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        compare_and_save(&path, "memo-a", "original", "").unwrap();
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(matches!(
            compare_and_save(&path, "memo-a", "replacement", "original"),
            Err(MemoWriteError::Storage(_))
        ));
        assert_eq!(read_strict(&path).unwrap()["memo-a"], "original");
    }
}
