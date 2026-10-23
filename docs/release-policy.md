# 릴리스 버전 정책

결정 근거: [ADR-0281](adr/0281-release-version-change-level.md). 현재 채널·서명·발행 계약은 [architecture/api-contracts.md](architecture/api-contracts.md#업데이트-채널-설정)를 따른다.

## 증가 기준

직전 정식 릴리스부터 이번 배포까지 포함되는 변경 전체를 보고 가장 높은 수준을 선택한다.

| 수준 | 기준 | `1.0.26` 기준 예 |
| --- | --- | --- |
| major | 기존 사용자 동작이나 공개 API·CLI·설정·복원 계약의 호환성 파괴 | `2.0.0` |
| minor | 호환되는 기능·설정 옵션·지원 환경·공개 계약 추가. 기본 비활성 기능도 포함 | `1.1.0` |
| patch | 기능 추가 없는 버그·보안·안정성·성능 수정 | `1.0.27` |
| 없음 | 내부 리팩터·문서·테스트만 변경하여 독립 배포가 필요하지 않음 | 유지 |

예를 들어 셸을 Codex로 오인하던 기존 동작 수정은 patch이고, Settings에서 Claude·Codex 훅을 설치·제거하거나 감지 방식을 선택하는 기능은 minor다. 한 릴리스에 여러 기능이 들어가도 minor를 기능 수만큼 올리지 않는다. 기능 구현 뒤 마지막 커밋이 버그 수정이더라도 전체 릴리스는 minor다.

PR 본문에 `버전 영향: major | minor | patch | 없음 — <구체적 이유>`를 적는다. 이는 릴리스 시점의 누적 판정을 위한 근거이며 PR마다 앱 버전을 변경하라는 뜻이 아니다.

## 발행 절차

1. 직전 공개 정식 태그와 배포할 main 커밋 사이의 PR·변경을 확인하고, 가장 높은 수준과 선택 이유를 릴리스 준비 PR에 기록한다. 준비 중 새 변경이 들어오면 다시 판정한다.
2. 목표 버전을 정하고 `src-tauri/tauri.conf.json`과 `src-tauri/Cargo.toml`을 같은 값으로 변경한다. `Cargo.lock`의 laymux 패키지 버전도 갱신한다. `ui/package.json`은 앱 배포 버전의 원본이 아니다.
3. beta는 목표 정식의 `x.y.z-beta.N`을 사용한다. `1.1.0-beta.1` → `1.1.0-beta.2` → `1.1.0`이며 정식 승격만을 이유로 `1.2.0`으로 올리지 않는다. 새 변경 때문에 필요한 수준이 달라지면 목표 버전을 다시 결정한다. Android APK를 발행할 때는 기존 인코딩 한계(beta 슬롯 1–8 포함)를 함께 검사한다.
4. 필요한 테스트·빌드와 ADR 검토 후 릴리스 준비 변경을 main에 머지한다. `Release` workflow를 해당 main 커밋에서 목표 tag로 실행한다. `prerelease`와 태그 접미사를 맞추고, Android 발행 여부는 실제 Android 변경과 기존 발행 게이트에 따라 선택한다.
5. 공개 태그·앱·채널 manifest 버전, 설치 파일·서명, workflow 완료를 확인한다. 이미 발행한 태그·버전은 다시 쓰지 않는다.

현재 CI는 버전 문법, 앱과 태그의 일치, 채널 전진성을 검사한다. 기능인지 수정인지 의미적으로 자동 판정하지 않으므로 해당 판단은 PR 리뷰와 발행 전 검토에서 수행한다. Remote 호환성 버전은 별도 계약이며 앱 minor 증가와 기계적으로 연결하지 않는다. Android 미발행 시 Android 채널은 기존 버전을 유지한다.

## v2.1.0 Ubuntu 설치 패키지 추가

[ADR-0349](adr/0349-v210-supplemental-ubuntu-deb.md)에 따라 공개된 `v2.1.0` 태그에 MCP 초기화 목록의 Linux 타입 명시 패치만 적용해 Ubuntu 22.04 x86_64용 release deb를 추가한다. 정기 Release workflow의 Windows·Android 범위는 유지한다.

1. 별도 Linux 파일시스템에 태그를 복제하고 기준 커밋·버전을 확인한다. 공개할 타입 명시 패치를 적용하고 해당 수정 외 추적 파일 변경이 없는지 확인한다.
2. Windows에서 같은 태그의 frontend를 production 빌드한 뒤 Linux 복제본의 `ui/dist`에 복사한다. Windows `ui/node_modules`에 WSL npm 설치를 실행하지 않는다.
3. Ubuntu에서 native agent hook helper를 release 빌드한다. 패키징 overlay에 `build.beforeBuildCommand: ""`, `bundle.createUpdaterArtifacts: false`를 지정하고 Tauri CLI 2.10.1의 `build --ci --bundles deb --config <overlay> -- --locked`를 실행한다. 버전·공개 태그는 수정하지 않는다.
4. deb의 Version·Architecture·포함 파일·ELF 동적 라이브러리 의존성을 검사하고 SHA-256을 생성한다. deb·checksum·빌드 패치·출처 파일을 새 이름으로 업로드하며 기존 asset은 덮어쓰지 않는다. 출처 파일에 기준 태그 커밋, 도구 버전, 패치·패키지 SHA-256과 실제 검증 범위를 남긴다.
5. 공개 파일의 크기·SHA-256 및 기존 Windows asset·`latest.json`·네 채널 파일의 무변경을 확인한다. 이 추가 패키지는 직접 설치용이며 Linux 자동 업데이트를 재개하지 않는다.
