# 0240. 릴리스는 당분간 Windows와 Android만 배포한다

- Status: Accepted
- Date: 2026-09-07
- Source: 사용자 요구(Windows 설치·업데이트와 Android APK만 필요, Linux 빌드 대기 제거), [ADR-0190](0190-update-release-channels.md), [ADR-0223](0223-android-release-advances-only-with-apk.md)
- 관계: ADR-0190의 데스크톱 배포 플랫폼 범위를 축소한다. 채널과 서명 계약은 유지한다.

## Context

Windows 패키지 이후 Linux 데스크톱 빌드를 순차 실행하므로 Windows 사용자가 Linux 빌드까지 기다린다. 사용자는 당분간 Windows 설치·자동 업데이트와 Android APK 배포만 요구한다. Linux 소스 지원 삭제나 채널별 버전 분리는 범위 밖이다.

## Decision

**데스크톱 릴리스는 Windows x86_64만 빌드하고 Android APK의 기존 선택 발행을 유지한다.**

- Windows 설치 파일과 updater 서명·메타데이터는 기존 Tauri 발행 경로를 사용한다. Linux AppImage/deb/rpm 빌드와 필수 플랫폼 검증을 제거한다.
- 채널 매니페스트는 windows-x86_64를 필수로 요구한다. 과거 Linux 항목이 포함된 매니페스트도 읽을 수 있지만, 제공된 모든 플랫폼의 URL·서명·태그 검증은 유지한다. 새 매니페스트에 과거 Linux 바이너리를 새 버전인 것처럼 섞지 않는다.
- Linux 배포 중단 기간에는 새 Linux 설치·자동 업데이트를 제공하지 않는다. 기존 바이너리·릴리스는 보존하며, Linux 재개 시 빌드와 필수 플랫폼 검증을 함께 복원한다.
- Windows의 WSL 기능에 필요한 정적 Linux 동반 바이너리는 계속 빌드한다. 이는 Linux 데스크톱 배포물이 아니다.
- Android APK는 기존 publish_android 입력, 서명 검증, 실제 APK 발행 시에만 채널을 전진시키는 계약을 유지한다.

## Alternatives Considered

- Linux 빌드를 병렬화: 사용자가 원하지 않는 배포 작업과 리소스 사용을 남기며 updater 매니페스트 병합 경합도 관리해야 한다.
- 예전 Linux 바이너리를 새 매니페스트에 유지: 매니페스트 버전과 바이너리 버전이 달라져 잘못된 업데이트를 제안한다.
- 새 플랫폼 선택 옵션: 당분간 고정된 배포 대상이므로 불필요한 설정과 검증 분기를 추가하지 않는다.

## Consequences

Windows 릴리스 공개가 Linux 데스크톱 빌드를 기다리지 않는다. Android와 Windows WSL 기능은 유지한다. Linux 사용자는 중단 이후 채널에서 자기 플랫폼 항목을 받지 못하며 업데이트 확인 오류가 날 수 있다. 재개 요구가 있으면 Linux 빌드와 플랫폼 검증을 같이 복구한다. Windows 단독 매니페스트 허용, 필수 Windows 누락 거부, 선택적 Linux 항목의 안전성 검증을 테스트한다.
