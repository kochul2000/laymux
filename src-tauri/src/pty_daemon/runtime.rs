//! Content-addressed images live outside the GUI installer directory.
use crate::daemon_transport::private_directory;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "runtime.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    protocol: u32,
    files: BTreeMap<String, String>,
}

pub(crate) fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        digest.update(&chunk[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn validate_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.len() > 128
        || name == MANIFEST_FILE
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
        || name.contains(':')
    {
        return Err(AppError::Other("daemon runtime file name rejected".into()));
    }
    Ok(())
}

pub(crate) fn stage(
    root: &Path,
    sources: &[(String, PathBuf)],
) -> Result<(String, PathBuf), AppError> {
    if sources.is_empty() || sources.len() > 32 {
        return Err(AppError::Other("daemon runtime inventory rejected".into()));
    }
    let mut files = BTreeMap::new();
    for (name, source) in sources {
        validate_name(name)?;
        if files.insert(name.clone(), hash_file(source)?).is_some() {
            return Err(AppError::Other("daemon runtime duplicate file".into()));
        }
    }
    let manifest = serde_json::to_vec(&Manifest {
        protocol: crate::daemon_protocol::PROTOCOL_VERSION,
        files,
    })?;
    let identity = format!("{:x}", Sha256::digest(&manifest));
    let directory = root.join(&identity);
    if directory.exists() {
        private_directory(&directory)?;
        verify(&directory, &identity)?;
        return Ok((identity, directory));
    }
    // A process-local staging directory is never advertised. Publishing the
    // complete directory with rename avoids a new GUI seeing half a runtime.
    let temporary = root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    private_directory(&temporary)?;
    let result = (|| {
        for (name, source) in sources {
            std::fs::copy(source, temporary.join(name))?;
        }
        std::fs::write(temporary.join(MANIFEST_FILE), &manifest)?;
        verify(&temporary, &identity)?;
        std::fs::rename(&temporary, &directory)?;
        Ok((identity, directory))
    })();
    if result.is_err() {
        // The exact mk-style staging path is owned by this call. No live
        // content-addressed bundle is overwritten or removed on failure.
        if let (Ok(owned), Ok(parent)) = (temporary.canonicalize(), root.canonicalize()) {
            if owned.parent() == Some(parent.as_path()) {
                let _ = std::fs::remove_dir_all(&owned);
            }
        }
    }
    result
}

pub(crate) fn verify(directory: &Path, identity: &str) -> Result<(), AppError> {
    if identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Other("daemon runtime identity rejected".into()));
    }
    let manifest_path = directory.join(MANIFEST_FILE);
    if std::fs::metadata(&manifest_path)?.len() > 16 * 1024 {
        return Err(AppError::Other("daemon runtime manifest too large".into()));
    }
    let bytes = std::fs::read(&manifest_path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != identity {
        return Err(AppError::Other(
            "daemon runtime manifest integrity rejected".into(),
        ));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.protocol != crate::daemon_protocol::PROTOCOL_VERSION
        || manifest.files.is_empty()
        || manifest.files.len() > 32
    {
        return Err(AppError::Other(
            "daemon runtime manifest version rejected".into(),
        ));
    }
    for (name, hash) in manifest.files {
        validate_name(&name)?;
        let path = directory.join(name);
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() || hash_file(&path)? != hash {
            return Err(AppError::Other(
                "daemon runtime file integrity rejected".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_new_bundle_never_changes_an_existing_live_bundle() {
        let fixture = tempfile::tempdir().unwrap();
        let runtime_root = fixture.path().join("runtimes");
        private_directory(&runtime_root).unwrap();
        let source = fixture.path().join("image");
        std::fs::write(&source, b"version-one").unwrap();
        let sources = vec![("image.exe".to_string(), source.clone())];
        let (first, directory) = stage(&runtime_root, &sources).unwrap();
        let pinned = std::fs::File::open(directory.join("image.exe")).unwrap();
        std::fs::write(source, b"version-two").unwrap();
        let (second, new) = stage(&runtime_root, &sources).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            std::fs::read(directory.join("image.exe")).unwrap(),
            b"version-one"
        );
        assert_eq!(
            std::fs::read(new.join("image.exe")).unwrap(),
            b"version-two"
        );
        verify(&directory, &first).unwrap();
        drop(pinned);
    }

    #[test]
    fn altered_or_path_traversing_bundles_are_rejected() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("runtimes");
        private_directory(&root).unwrap();
        let source = fixture.path().join("image");
        std::fs::write(&source, b"image").unwrap();
        assert!(stage(&root, &[("../escape".into(), source.clone())]).is_err());
        let (id, bundle) = stage(&root, &[("image.exe".into(), source)]).unwrap();
        std::fs::write(bundle.join("image.exe"), b"changed").unwrap();
        assert!(verify(&bundle, &id).is_err());
        assert!(!fixture.path().join("escape").exists());
    }
}
