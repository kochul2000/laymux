//! Windows ConPTY 런타임 사이드로드 (issue #580, ADR-0067).
//!
//! in-box conhost 는 자식이 보낸 `OSC 10/11`(전경/배경색 질의)을 **소비하고
//! 응답하지 않는다.** DSR·DA1 은 자기 상태로 답할 수 있어 답하고, 모르는
//! OSC(133/7/9;9)는 흘려보내지만, 색상 질의는 조용히 사라진다. Win32 콘솔
//! API 를 쓸 수 있는 네이티브 앱은 색 테이블을 직접 읽어 우회하지만, WSL 의
//! Linux 바이너리에는 VT 왕복 말고 다른 수단이 없다.
//!
//! Microsoft ConPTY 재배포본(`conpty.dll` + `OpenConsole.exe`)을 실행 파일
//! 옆에 두면 `portable-pty` 가 kernel32 대신 그쪽을 로드하고(`win/psuedocon.rs`
//! 의 `load_conpty`), 질의가 xterm 까지 도달해 응답이 성립한다. laymux 쪽
//! PTY 코드는 바뀌지 않는다 — 파일 배치가 전부다.
//!
//! `build.rs` 가 `#[path]` 로 이 파일을 그대로 불러 같은 표를 쓴다.

/// 벤더링한 ConPTY 재배포본 버전. `src-tauri/vendor/conpty/<version>/` 과 일치해야 한다.
pub const CONPTY_RUNTIME_VERSION: &str = "1.23.251008001";

/// 실행 파일 옆에 함께 놓여야 하는 파일. `conpty.dll` 은 `OpenConsole.exe` 를
/// 콘솔 호스트로 띄우므로 둘 중 하나만 배치하면 안 된다.
pub const CONPTY_RUNTIME_FILES: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];

/// `CARGO_CFG_TARGET_ARCH` 값을 벤더 디렉터리 이름으로 옮긴다.
///
/// 표에 없는 아키텍처는 `None` 이다. Windows build script는 이를 지원하지 않는
/// 타깃으로 취급해 빌드를 중단한다. 조용한 in-box conhost 폴백은 허용하지 않는다.
pub fn conpty_runtime_arch_dir(target_arch: &str) -> Option<&'static str> {
    match target_arch {
        "x86_64" => Some("win10-x64"),
        "aarch64" => Some("win10-arm64"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn vendor_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor")
            .join("conpty")
            .join(CONPTY_RUNTIME_VERSION)
    }

    #[test]
    fn maps_supported_windows_architectures() {
        assert_eq!(conpty_runtime_arch_dir("x86_64"), Some("win10-x64"));
        assert_eq!(conpty_runtime_arch_dir("aarch64"), Some("win10-arm64"));
    }

    #[test]
    fn unsupported_architecture_has_no_vendored_runtime() {
        assert_eq!(conpty_runtime_arch_dir("x86"), None);
        assert_eq!(conpty_runtime_arch_dir("riscv64"), None);
    }

    /// 벤더 트리가 표와 어긋나면 build script가 실패해야 한다. 이 테스트도
    /// 지원 아키텍처 표와 파일 쌍의 불일치를 더 이른 단계에서 잡는다.
    #[test]
    fn every_mapped_arch_has_both_vendored_files() {
        for arch in ["x86_64", "aarch64"] {
            let dir = vendor_root().join(
                conpty_runtime_arch_dir(arch).expect("mapped arch must have a vendor directory"),
            );
            for file in CONPTY_RUNTIME_FILES {
                let path = dir.join(file);
                let meta = std::fs::metadata(&path)
                    .unwrap_or_else(|error| panic!("missing vendored {}: {error}", path.display()));
                assert!(
                    meta.len() > 4096,
                    "vendored {} looks truncated ({} bytes)",
                    path.display(),
                    meta.len()
                );
            }
        }
    }

    /// LFS 포인터나 텍스트로 깨진 사본을 걸러낸다 — PE 헤더는 `MZ` 로 시작한다.
    #[test]
    fn vendored_files_are_pe_images() {
        for arch in ["x86_64", "aarch64"] {
            let dir = vendor_root().join(conpty_runtime_arch_dir(arch).expect("mapped arch"));
            for file in CONPTY_RUNTIME_FILES {
                let path = dir.join(file);
                let bytes = std::fs::read(&path).expect("vendored runtime file is readable");
                assert_eq!(&bytes[..2], b"MZ", "{} is not a PE image", path.display());
            }
        }
    }

    /// `build.rs` 가 실제로 실행 파일 옆에 복사했는지 확인한다. 테스트 바이너리는
    /// `target/<profile>/deps/` 에 있으므로 그 부모까지 본다.
    #[cfg(windows)]
    #[test]
    fn build_script_stages_runtime_next_to_executable() {
        let exe = std::env::current_exe().expect("test executable path");
        let candidates: Vec<PathBuf> = exe
            .ancestors()
            .skip(1)
            .take(2)
            .map(Path::to_path_buf)
            .collect();
        let staged = candidates.iter().any(|dir| {
            CONPTY_RUNTIME_FILES
                .iter()
                .all(|file| dir.join(file).is_file())
        });
        assert!(
            staged,
            "build.rs must copy {:?} next to the built executable; looked in {:?}",
            CONPTY_RUNTIME_FILES, candidates
        );
    }
}
