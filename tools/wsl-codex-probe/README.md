# WSL Codex 조회 도구

Windows laymux에 동봉하는 일회성 Linux x64 프로그램이다. Python, sqlite3 CLI,
동적 libc 의존성 없이 `/proc` 소유권을 확인하고 Codex SQLite를 읽기 전용으로 조회한다.
사용자는 설치·설정할 것이 없다. 실패 시 JSON 성공 응답을 만들지 않는다.

개발/CI에서 Linux Rust stable 및 C 빌드 도구를 사용한다:

```sh
cargo test --locked -p laymux-wsl-codex-probe
bash scripts/build-wsl-probe.sh
```

그 뒤 Windows에서 평소처럼 `cargo tauri dev`/`cargo tauri build`를 실행한다.
생성 바이너리는 git에 넣지 않는다. 배포 workflow가 빌드하고 NSIS가 동봉한다.
도구가 없으면 Windows 빌드를 실패시켜 미지원 상태를 정상 설치본으로 배포하지 않는다.

ADR: [0238](../../docs/adr/0238-codex-lifecycle-storage-checkpoint.md).
