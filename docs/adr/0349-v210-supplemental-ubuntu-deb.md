# 0349. v2.1.0에 Ubuntu deb 설치 패키지를 추가한다

- Status: Accepted
- Date: 2026-10-20
- Source: 사용자 요구(v2.1.0 Ubuntu 릴리스 빌드 추가), [릴리스 정책](../release-policy.md), [ADR-0240](0240-windows-android-release-targets.md)
- 관계: ADR-0240의 정기 Windows·Android 배포 범위에 v2.1.0 Ubuntu 설치 패키지의 일회성 추가를 허용한다. 정기 Linux 배포·자동 업데이트 재개는 결정하지 않는다.

## Context

v2.1.0은 Windows 정식 릴리스로 이미 공개됐다. 사용자는 같은 버전의 Ubuntu 릴리스 빌드를 추가로 요구했다. 기존 공개 태그를 바꾸거나 Windows 설치 파일·업데이트 메타데이터를 다시 발행하면 검증된 설치 파일과 소스의 대응 관계를 훼손한다. 실제 Ubuntu 빌드에서 MCP 초기화의 `vec![None]`이 Windows 전용 목록 확장 없이 타입을 추론하지 못해 컴파일이 실패했다. Ubuntu 추가 패키지에는 기존 태그 보존과 최소 빌드 패치의 추적 경계가 필요하다.

## Decision

**공개된 v2.1.0 태그에 Linux 컴파일을 위한 타입 명시 패치만 적용해 Ubuntu 22.04 x86_64에서 release 빌드하고, deb·SHA-256·패치·출처 기록을 같은 GitHub Release에 추가한다.**

- 기준 소스는 공개 태그 `v2.1.0`이 가리키는 커밋이다. 공개 버전·태그·기존 asset은 변경하지 않는다. Ubuntu 빌드에는 MCP 초기화 목록의 `Vec<Option<String>>` 타입 명시만 적용하며 런타임 동작·API·설정은 바꾸지 않는다. 이 수정은 main에도 반영한다.
- Ubuntu 패키지의 출처는 기준 태그 커밋과 공개된 빌드 패치의 조합이다. 이를 수정 없는 원본 태그 빌드라고 표시하지 않는다. 패치와 기준 커밋·도구 버전·패치 및 패키지 SHA-256을 담은 출처 파일을 패키지와 함께 첨부한다.
- frontend는 같은 태그의 소스와 lockfile에 대응하는 Windows 작업공간에서 production 빌드하고, 별도 Linux 파일시스템의 소스 복제본에 복사한다. Windows `ui/node_modules`에 Linux 의존성을 설치하지 않는다. native 앱과 agent hook helper는 Ubuntu에서 빌드한다.
- 패키징에서만 `beforeBuildCommand`를 비우고 `createUpdaterArtifacts`를 끈다. frontend와 native helper를 먼저 준비하고 deb만 생성한다. 이 빌드 설정은 소스 태그를 수정하지 않는 외부 overlay다.
- 패키지의 버전·아키텍처·내용·동적 라이브러리 의존성을 검사하고 SHA-256을 기록한 뒤 새 파일명으로 첨부한다. 같은 이름의 기존 asset을 덮어쓰지 않는다. 타입 명시 외 수정이 더 필요해지면 같은 버전 추가 배포의 범위를 다시 판단한다.
- 기존 Windows 설치 파일·서명·`latest.json` 및 desktop·Android 채널 파일은 보존한다. Ubuntu deb는 직접 설치용이며 서명된 Linux updater artifact나 새 플랫폼 채널을 제공하지 않는다.

## Alternatives Considered

- 정기 Linux 릴리스와 updater 플랫폼을 함께 복원: 사용자는 특정 버전의 Ubuntu 빌드를 요구했다. 이후 모든 배포의 플랫폼·서명·필수 검증 범위를 바꾸는 결정은 이번 추가 패키지와 분리한다.
- main의 최신 소스로 v2.1.0을 다시 빌드: 공개 태그와 다른 애플리케이션을 같은 버전으로 제공할 수 있어 기각한다.
- 기존 Release workflow 전체를 재실행: 이미 공개된 태그의 재발행은 기존 게이트가 거절하며 Windows 산출물까지 다시 생성할 필요도 없다.

## Consequences

Ubuntu 사용자는 Windows와 같은 소스 버전의 deb를 직접 내려받아 설치할 수 있다. 기존 Windows 업데이트와 Android 채널에는 영향을 주지 않는다. Ubuntu 자동 업데이트와 정기 배포는 별도 결정이 필요하며, 이번 패키지의 checksum은 전송 무결성 확인 수단으로 사용한다. 새로운 태그나 패키지에 이 예외를 확장할 때에는 배포 범위와 검증 정책을 다시 검토한다.
