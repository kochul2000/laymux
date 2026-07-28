use std::path::PathBuf;

#[path = "src/build_metadata.rs"]
mod build_metadata;
#[path = "src/conpty_build.rs"]
mod conpty_build;
use conpty_build::{copy_runtime_file, tauri_config_without_runtime_resources, CopyOutcome};

// 벤더 버전·파일 목록·아키텍처 표는 크레이트와 빌드 스크립트가 같은 정본을 본다.
#[path = "src/conpty_runtime.rs"]
mod conpty_runtime;
use conpty_runtime::{conpty_runtime_arch_dir, CONPTY_RUNTIME_FILES, CONPTY_RUNTIME_VERSION};

fn main() {
    println!("cargo:rerun-if-changed=src/conpty_build.rs");
    println!("cargo:rerun-if-changed=src/conpty_runtime.rs");
    emit_build_metadata();

    // tauri_build 가 resources 경로를 검증하므로 스테이징이 먼저 끝나야 한다.
    if stage_conpty_runtime() {
        suppress_tauri_build_runtime_copy();
    }
    tauri_build::build();
}

/// Inject immutable source identity without invoking `git` (and therefore
/// without flashing a console window on Windows builds).
fn emit_build_metadata() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(worktree_root) = manifest_dir.parent() else {
        println!("cargo:rustc-env=LAYMUX_BUILD_WORKTREE_ROOT=");
        println!("cargo:rustc-env=LAYMUX_BUILD_GIT_COMMIT=");
        println!("cargo:rustc-env=LAYMUX_BUILD_GIT_BRANCH=");
        return;
    };
    let metadata = build_metadata::discover(worktree_root);

    for path in metadata.rerun_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!(
        "cargo:rustc-env=LAYMUX_BUILD_WORKTREE_ROOT={}",
        metadata.worktree_root.display()
    );
    println!(
        "cargo:rustc-env=LAYMUX_BUILD_GIT_COMMIT={}",
        metadata.git_commit.as_deref().unwrap_or("")
    );
    println!(
        "cargo:rustc-env=LAYMUX_BUILD_GIT_BRANCH={}",
        metadata.git_branch.as_deref().unwrap_or("")
    );
}

/// Windows ConPTY 재배포본을 실행 파일 옆과 번들러 스테이징 디렉터리에 복사한다.
///
/// `portable-pty` 는 `LoadLibrary("conpty.dll")` 로 사이드로드본을 먼저 찾는데,
/// 그 검색 경로는 **실행 파일이 있는 디렉터리**다. `cargo run`/`tauri dev` 는
/// `target/<profile>/` 에서 돌고, 설치본은 `tauri.windows.conf.json` 의
/// resources 가 `gen/conpty/` 를 exe 옆으로 옮긴다. 두 경로 모두 여기서 채운다.
///
/// 배치에 실패하면 빌드를 세운다. 조용히 넘어가면 in-box conhost 로 폴백한 채
/// 출시되고, 그 증상은 실기에서 색이 이상한 형태로만 드러난다([ADR-0067]).
fn stage_conpty_runtime() -> bool {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return false;
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
            let outcome = copy_runtime_file(&source, &destination).unwrap_or_else(|error| {
                panic!(
                    "failed to copy {} -> {}: {error}",
                    source.display(),
                    destination.display()
                )
            });
            if outcome == CopyOutcome::RetainedAfterSharingViolation {
                println!(
                    "cargo:warning=kept the byte-identical existing {} after a sharing violation",
                    destination.display()
                );
            }
        }
    }

    true
}

/// `tauri-build` 는 bundle resources 를 dev 실행 파일 옆에도 다시 복사한다.
/// ConPTY 는 위에서 이미 정확히 배치했으므로 build script 안에서만 그 두 resource 를
/// 제외한다. 부모 Tauri CLI 의 설정은 바뀌지 않아 실제 installer bundling 은 유지된다.
fn suppress_tauri_build_runtime_copy() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let environment_config = std::env::var("TAURI_CONFIG").ok();
    let filtered = tauri_config_without_runtime_resources(
        &manifest_dir,
        &target_os,
        environment_config.as_deref(),
    )
    .unwrap_or_else(|error| panic!("failed to filter ConPTY build resources: {error}"));

    // The build script is single-threaded here and tauri_build reads the value immediately.
    std::env::set_var("TAURI_CONFIG", filtered);
}

/// `OUT_DIR`(`target/<triple>?/<profile>/build/<pkg>-<hash>/out`)에서 실행 파일이
/// 놓이는 `target/<triple>?/<profile>/` 을 되짚는다.
fn cargo_target_profile_dir() -> Option<PathBuf> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").ok()?);
    let profile_dir = out_dir.ancestors().nth(3)?;
    profile_dir.is_dir().then(|| profile_dir.to_path_buf())
}
