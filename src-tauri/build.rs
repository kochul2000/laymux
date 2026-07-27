use std::path::PathBuf;

// 벤더 버전·파일 목록·아키텍처 표는 크레이트와 빌드 스크립트가 같은 정본을 본다.
#[path = "src/conpty_runtime.rs"]
mod conpty_runtime;
use conpty_runtime::{conpty_runtime_arch_dir, CONPTY_RUNTIME_FILES, CONPTY_RUNTIME_VERSION};

fn main() {
    // tauri_build 가 resources 경로를 검증하므로 스테이징이 먼저 끝나야 한다.
    stage_conpty_runtime();
    tauri_build::build();
}

/// Windows ConPTY 재배포본을 실행 파일 옆과 번들러 스테이징 디렉터리에 복사한다.
///
/// `portable-pty` 는 `LoadLibrary("conpty.dll")` 로 사이드로드본을 먼저 찾는데,
/// 그 검색 경로는 **실행 파일이 있는 디렉터리**다. `cargo run`/`tauri dev` 는
/// `target/<profile>/` 에서 돌고, 설치본은 `tauri.windows.conf.json` 의
/// resources 가 `gen/conpty/` 를 exe 옆으로 옮긴다. 두 경로 모두 여기서 채운다.
///
/// 배치에 실패하면 빌드를 세운다. 조용히 넘어가면 in-box conhost 로 폴백한 채
/// 출시되고, 그 증상은 실기에서 색이 이상한 형태로만 드러난다([ADR-0066]).
fn stage_conpty_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let arch_dir = conpty_runtime_arch_dir(&target_arch).unwrap_or_else(|| {
        panic!(
            "no vendored ConPTY runtime for target arch '{target_arch}'; \
             add it under src-tauri/vendor/conpty/{CONPTY_RUNTIME_VERSION}/ \
             and extend conpty_runtime_arch_dir"
        )
    });

    let source_dir = manifest_dir
        .join("vendor")
        .join("conpty")
        .join(CONPTY_RUNTIME_VERSION)
        .join(arch_dir);
    let bundle_dir = manifest_dir.join("gen").join("conpty");
    let exe_dir = cargo_target_profile_dir()
        .expect("cargo output directory must be resolvable to stage the ConPTY runtime");

    std::fs::create_dir_all(&bundle_dir)
        .unwrap_or_else(|error| panic!("failed to create {}: {error}", bundle_dir.display()));

    for file in CONPTY_RUNTIME_FILES {
        let source = source_dir.join(file);
        println!("cargo:rerun-if-changed={}", source.display());
        assert!(
            source.is_file(),
            "missing vendored ConPTY file {}",
            source.display()
        );

        for destination in [exe_dir.join(file), bundle_dir.join(file)] {
            if let Err(error) = std::fs::copy(&source, &destination) {
                // 실행 중인 인스턴스가 DLL 을 잡고 있으면 덮어쓰기가 막힌다. 같은
                // 버전이 이미 놓여 있으면 동작에 문제가 없으므로 그 경우만 넘어간다.
                assert!(
                    same_size_file(&source, &destination),
                    "failed to copy {} -> {}: {error}",
                    source.display(),
                    destination.display()
                );
                println!(
                    "cargo:warning=kept the existing {} (in use); {error}",
                    destination.display()
                );
            }
        }
    }
}

fn same_size_file(source: &PathBuf, destination: &PathBuf) -> bool {
    match (std::fs::metadata(source), std::fs::metadata(destination)) {
        (Ok(source_meta), Ok(destination_meta)) => source_meta.len() == destination_meta.len(),
        _ => false,
    }
}

/// `OUT_DIR`(`target/<triple>?/<profile>/build/<pkg>-<hash>/out`)에서 실행 파일이
/// 놓이는 `target/<triple>?/<profile>/` 을 되짚는다.
fn cargo_target_profile_dir() -> Option<PathBuf> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").ok()?);
    let profile_dir = out_dir.ancestors().nth(3)?;
    profile_dir.is_dir().then(|| profile_dir.to_path_buf())
}
