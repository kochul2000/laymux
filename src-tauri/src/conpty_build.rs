use serde_json::{Map, Value};
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyOutcome {
    Copied,
    Unchanged,
    RetainedAfterSharingViolation,
}

pub(crate) fn files_have_same_contents(source: &Path, destination: &Path) -> io::Result<bool> {
    let source_metadata = std::fs::metadata(source)?;
    let destination_metadata = match std::fs::metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !source_metadata.is_file()
        || !destination_metadata.is_file()
        || source_metadata.len() != destination_metadata.len()
    {
        return Ok(false);
    }

    readers_have_same_contents(
        BufReader::new(File::open(source)?),
        BufReader::new(File::open(destination)?),
        source_metadata.len(),
    )
}

/// Compares `length` bytes from both readers.
///
/// `Read::read` may return fewer bytes than the buffer holds even when more data
/// is available, so comparing one `read` call against another would report two
/// identical files as different the moment the readers fall out of lockstep. The
/// length is already known to match, so fill same-sized chunks with `read_exact`
/// instead of trusting that contract.
fn readers_have_same_contents(
    mut source: impl Read,
    mut destination: impl Read,
    length: u64,
) -> io::Result<bool> {
    let mut source_buffer = [0_u8; 64 * 1024];
    let mut destination_buffer = [0_u8; 64 * 1024];
    let mut remaining = length;

    while remaining > 0 {
        let chunk = remaining.min(source_buffer.len() as u64) as usize;
        if !read_chunk_exact(&mut source, &mut source_buffer[..chunk])?
            || !read_chunk_exact(&mut destination, &mut destination_buffer[..chunk])?
            || source_buffer[..chunk] != destination_buffer[..chunk]
        {
            return Ok(false);
        }
        remaining -= chunk as u64;
    }
    Ok(true)
}

fn read_chunk_exact(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<bool> {
    match reader.read_exact(buffer) {
        Ok(()) => Ok(true),
        // A file that shrank between the length check and this read is not a
        // byte-for-byte match. Report the difference instead of failing the build.
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn is_expected_sharing_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(32)
}

pub(crate) fn copy_runtime_file(source: &Path, destination: &Path) -> io::Result<CopyOutcome> {
    if files_have_same_contents(source, destination)? {
        return Ok(CopyOutcome::Unchanged);
    }

    match std::fs::copy(source, destination) {
        Ok(_) => {
            if files_have_same_contents(source, destination)? {
                Ok(CopyOutcome::Copied)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "copied ConPTY runtime does not match its vendored source",
                ))
            }
        }
        Err(copy_error) if is_expected_sharing_error(&copy_error) => {
            match files_have_same_contents(source, destination) {
                Ok(true) => Ok(CopyOutcome::RetainedAfterSharingViolation),
                Ok(false) => Err(copy_error),
                Err(compare_error) => Err(io::Error::new(
                    copy_error.kind(),
                    format!(
                        "{copy_error}; failed to verify the existing runtime after the sharing violation: {compare_error}"
                    ),
                )),
            }
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn tauri_config_without_runtime_resources(
    manifest_dir: &Path,
    target_os: &str,
    environment_config: Option<&str>,
) -> Result<String, String> {
    let mut merged = read_json_config(&manifest_dir.join("tauri.conf.json"))?;
    let platform_config_path = manifest_dir.join(format!("tauri.{target_os}.conf.json"));
    if platform_config_path.is_file() {
        let platform_config = read_json_config(&platform_config_path)?;
        merge_json(&mut merged, &platform_config);
    }

    let mut environment_overlay = match environment_config {
        Some(config) => serde_json::from_str(config)
            .map_err(|error| format!("invalid TAURI_CONFIG JSON: {error}"))?,
        None => Value::Object(Map::new()),
    };
    if environment_config.is_some() {
        merge_json(&mut merged, &environment_overlay);
    }

    let resources = merged
        .pointer("/bundle/resources")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let resources = runtime_resource_removal_overlay(resources)?;
    set_bundle_resources(&mut environment_overlay, resources)?;
    serde_json::to_string(&environment_overlay)
        .map_err(|error| format!("failed to serialize filtered TAURI_CONFIG: {error}"))
}

fn read_json_config(path: &Path) -> Result<Value, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

/// RFC 7396 merge semantics used by Tauri's configuration overlay.
fn merge_json(document: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *document = patch.clone();
        return;
    };
    if !document.is_object() {
        *document = Value::Object(Map::new());
    }
    let document = document.as_object_mut().expect("object assigned above");
    for (key, value) in patch {
        if value.is_null() {
            document.remove(key);
        } else {
            merge_json(document.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

fn runtime_resource_removal_overlay(mut resources: Value) -> Result<Value, String> {
    match &mut resources {
        Value::Object(resources) => {
            for (source, target) in resources.iter_mut() {
                if target
                    .as_str()
                    .is_some_and(|target| is_runtime_resource(source, target))
                {
                    // tauri-build merges TAURI_CONFIG into the platform config. Omitting
                    // an object key preserves it, while null removes it (RFC 7396).
                    *target = Value::Null;
                }
            }
        }
        Value::Array(resources) => {
            resources.retain(|source| !source.as_str().is_some_and(is_runtime_resource_source));
        }
        Value::Null => resources = Value::Array(Vec::new()),
        _ => return Err("bundle.resources must be an object or array".to_string()),
    }
    Ok(resources)
}

fn set_bundle_resources(config: &mut Value, resources: Value) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| "TAURI_CONFIG root must be an object".to_string())?;
    let bundle = root
        .entry("bundle")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "TAURI_CONFIG bundle must be an object".to_string())?;
    bundle.insert("resources".to_string(), resources);
    Ok(())
}

/// Matches the ConPTY entries of `tauri.windows.conf.json`'s resource map by
/// **both** the `gen/conpty/` source path and the target file name. Moving the
/// staging directory without updating [`is_runtime_resource_source`] therefore
/// silently stops excluding them, and `tauri-build` copies them next to the dev
/// executable a second time — which fails the build with
/// `ERROR_SHARING_VIOLATION` whenever a dev instance has the DLL loaded. Loud,
/// but the cause is one function away from the path that changed.
fn is_runtime_resource(source: &str, target: &str) -> bool {
    let target = normalized_path(target);
    let expected_target = target == "conpty.dll" || target == "openconsole.exe";
    expected_target && is_runtime_resource_source(source)
}

fn is_runtime_resource_source(source: &str) -> bool {
    let source = normalized_path(source);
    ["conpty.dll", "openconsole.exe"].iter().any(|file| {
        source == format!("gen/conpty/{file}") || source.ends_with(&format!("/gen/conpty/{file}"))
    })
}

fn normalized_path(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn same_length_different_files_are_not_equal() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.dll");
        let destination = dir.path().join("destination.dll");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&destination, b"staler").unwrap();

        assert!(!files_have_same_contents(&source, &destination).unwrap());
    }

    /// Yields at most `limit` bytes per `read` call even when more are buffered,
    /// which `Read::read` is allowed to do and `File` can do on some platforms.
    struct ShortReader {
        data: Vec<u8>,
        offset: usize,
        limit: usize,
    }

    impl Read for ShortReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let available = self.data.len() - self.offset;
            let count = available.min(buffer.len()).min(self.limit);
            buffer[..count].copy_from_slice(&self.data[self.offset..self.offset + count]);
            self.offset += count;
            Ok(count)
        }
    }

    fn short_reader(data: &[u8], limit: usize) -> ShortReader {
        ShortReader {
            data: data.to_vec(),
            offset: 0,
            limit,
        }
    }

    #[test]
    fn identical_contents_match_even_when_reads_are_short_and_unaligned() {
        let data: Vec<u8> = (0..200_000_u32).map(|index| index as u8).collect();

        assert!(readers_have_same_contents(
            short_reader(&data, 7),
            short_reader(&data, 4_099),
            data.len() as u64,
        )
        .unwrap());
    }

    #[test]
    fn differing_tail_beyond_the_first_chunk_is_detected() {
        let source: Vec<u8> = (0..200_000_u32).map(|index| index as u8).collect();
        let mut destination = source.clone();
        *destination.last_mut().unwrap() ^= 0xff;

        assert!(!readers_have_same_contents(
            short_reader(&source, 8_192),
            short_reader(&destination, 8_192),
            source.len() as u64,
        )
        .unwrap());
    }

    #[test]
    fn a_reader_that_ends_early_is_not_a_match() {
        let source = vec![7_u8; 4_096];

        assert!(!readers_have_same_contents(
            short_reader(&source, 512),
            short_reader(&source[..2_048], 512),
            source.len() as u64,
        )
        .unwrap());
    }

    #[test]
    fn only_windows_sharing_violations_are_retryable() {
        assert!(is_expected_sharing_error(&io::Error::from_raw_os_error(32)));
        assert!(!is_expected_sharing_error(&io::Error::from_raw_os_error(5)));
        assert!(!is_expected_sharing_error(&io::Error::from_raw_os_error(
            112
        )));
        assert!(!is_expected_sharing_error(&io::Error::new(
            io::ErrorKind::NotFound,
            "missing",
        )));
    }

    #[test]
    fn identical_read_only_destination_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.dll");
        let destination = dir.path().join("destination.dll");
        std::fs::write(&source, b"same runtime").unwrap();
        std::fs::write(&destination, b"same runtime").unwrap();

        let original_permissions = std::fs::metadata(&destination).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(&destination, permissions).unwrap();

        let result = copy_runtime_file(&source, &destination);

        std::fs::set_permissions(&destination, original_permissions).unwrap();
        assert_eq!(result.unwrap(), CopyOutcome::Unchanged);
    }

    #[test]
    fn same_length_stale_read_only_destination_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.dll");
        let destination = dir.path().join("destination.dll");
        std::fs::write(&source, b"new runtime").unwrap();
        std::fs::write(&destination, b"old runtime").unwrap();

        let original_permissions = std::fs::metadata(&destination).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(&destination, permissions).unwrap();

        let result = copy_runtime_file(&source, &destination);

        std::fs::set_permissions(&destination, original_permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"old runtime");
    }

    #[test]
    fn build_config_removes_only_conpty_runtime_resources() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("tauri.conf.json"),
            r#"{"bundle":{"resources":{"assets/help.txt":"help.txt"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("tauri.windows.conf.json"),
            r#"{"bundle":{"resources":{"gen/conpty/conpty.dll":"conpty.dll","gen/conpty/OpenConsole.exe":"OpenConsole.exe"}}}"#,
        )
        .unwrap();
        let environment =
            r#"{"bundle":{"resources":{"assets/extra.txt":"extra.txt"}},"productName":"Override"}"#;

        let filtered =
            tauri_config_without_runtime_resources(dir.path(), "windows", Some(environment))
                .unwrap();
        let value: serde_json::Value = serde_json::from_str(&filtered).unwrap();

        assert_eq!(value["productName"], "Override");
        assert_eq!(value["bundle"]["resources"]["assets/help.txt"], "help.txt");
        assert_eq!(
            value["bundle"]["resources"]["assets/extra.txt"],
            "extra.txt"
        );
        assert!(value["bundle"]["resources"]["gen/conpty/conpty.dll"].is_null());
        assert!(value["bundle"]["resources"]["gen/conpty/OpenConsole.exe"].is_null());

        let mut resolved = read_json_config(&dir.path().join("tauri.conf.json")).unwrap();
        let platform = read_json_config(&dir.path().join("tauri.windows.conf.json")).unwrap();
        merge_json(&mut resolved, &platform);
        merge_json(&mut resolved, &serde_json::from_str(environment).unwrap());
        merge_json(&mut resolved, &value);
        assert!(resolved["bundle"]["resources"]
            .get("gen/conpty/conpty.dll")
            .is_none());
        assert!(resolved["bundle"]["resources"]
            .get("gen/conpty/OpenConsole.exe")
            .is_none());
    }
}
