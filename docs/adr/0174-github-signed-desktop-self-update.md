# 0174. PC 업데이트는 GitHub Releases와 고정 서명 키를 사용한다

- Status: Accepted
- Date: 2026-08-18
- Source: 사용자 요구("PC에서 GitHub 기준 업데이트 알림·실행", "Remote 접속 중에도 업데이트 확인·실행", "Android 앱 업데이트는 앱스토어 이후") · [architecture/overview.md §2](../architecture/overview.md) · [architecture/api-contracts.md §12·§13](../architecture/api-contracts.md) · [ADR-0013](0013-direct-remote-mode.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0170](0170-android-e2e-lease-dies-with-its-session.md)
- Extends: ADR-0013, ADR-0149, ADR-0170
- Amended by: [ADR-0190](0190-update-release-channels.md) — 단일 stable endpoint, `x.y.z` 전용 클라이언트 계약, prerelease 번들 집합·tag 검사·게시 게이트가 채널 계약으로 정정된다. 서명 검증, `UpdateManager` 소유권, Automation/Remote 노출 범위와 lease 정책은 유효하다.

## Context

Windows·Linux 사용자가 새 버전을 알기 위해 GitHub Releases를 직접 확인하고 설치 파일을 내려받아야 했다. 이 흐름은 앱 안에서 현재 버전과 최신 버전을 비교해 알릴 수 없고, 사용자가 PC 앞이 아닌 Remote 접속 중이면 업데이트를 발견하거나 시작할 방법도 없다.

프로세스 자기 교체는 일반 UI 동작보다 신뢰 경계가 크다. 릴리스 서버나 다운로드가 변조되어도 임의 바이너리를 실행해서는 안 되며, Remote의 읽기 권한만 가진 클라이언트가 PC 재시작을 유발해서도 안 된다. 반대로 설치를 시작한 직후 updater가 프로세스를 재시작하면 요청 연결과 controller lease가 끊기므로, 이미 승인된 설치를 lease 수명에 묶어 중간 취소하는 것도 안전하지 않다.

GitHub의 `release.published` event 뒤에 빌드하면 사람이 stable 형식이 아닌 Release를 latest로 발행한 뒤에야 CI가 실패하며, 두 플랫폼 중 첫 artifact만 올라간 부분 manifest도 stable endpoint에 노출될 수 있다. 또한 Release tag가 main 밖 커밋을 가리키면 branch protection을 거치지 않은 코드가 updater key로 서명된다. 따라서 릴리스 생성·서명·latest 승격 순서를 하나의 검증된 배포 transaction으로 묶어야 하며, 그 경계를 우회한 수동 발행에 대비한 클라이언트 검증도 필요하다.

범위는 GitHub Releases로 배포하는 Windows·Linux Tauri 앱의 stable 최신 버전 확인, 사용자에게 알림, 서명된 설치 및 재시작이다. Android APK/AAB 자체 업데이트, prerelease·복수 채널, delta update, 자동 무인 설치, rollback은 비목표다. Android 앱이 PC 소유 Remote 문서를 통해 **PC** 업데이트를 조작하는 것은 Remote 계약의 일부로 범위에 포함한다.

## Decision

**Windows·Linux Laymux는 GitHub의 최신 stable Release 메타데이터를 확인하고, 바이너리에 고정한 Tauri updater 공개키로 검증된 artifact만 사용자 승인 뒤 설치·재시작한다.**

- release workflow는 `workflow_dispatch`의 tag/prerelease 입력만 받으며 default branch에서 실행한 main 계보 commit만 배포한다. stable tag는 `v?x.y.z`이고 `tauri.conf.json` 버전과 일치해야 한다. 검증 뒤 workflow가 tag와 draft Release를 만들고 Windows x86_64·Linux x86_64 bundle 및 `latest.json` updater artifact를 직렬 업로드한다. stable은 Android job까지 포함해 모든 필수 job이 성공한 뒤에만 draft를 해제하고 latest로 승격하며, prerelease는 데스크톱 artifact 완성 뒤 latest가 아닌 prerelease로 게시한다. 실패한 Release는 draft로 남아 stable endpoint를 바꾸지 않는다. updater private key를 받는 Tauri Action은 검토한 full commit SHA로 고정한다.
- 앱에는 대응하는 public key와 `https://github.com/kochul2000/laymux/releases/latest/download/latest.json` endpoint를 고정하고, GitHub의 latest Release 지정을 stable 채널의 단일 진실원으로 삼는다. 앱은 별도 nightly 채널을 추론하지 않지만, 수동 발행이나 배포 주체 실수에 대한 최종 안전장치로 updater manifest의 `version`이 정확히 세 개의 숫자 성분(`x.y.z`)인지, download URL의 GitHub Release tag가 저장소의 기존 관례인 `v?x.y.z`인지, 두 버전이 같은지 검증한다. 하나라도 어긋나면 업데이트 없음으로 취급한다. 설치 직전 재확인한 후보도 같은 계약을 만족하면서 사용자가 승인한 버전과 정확히 같아야 한다. updater private key는 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`로만 주입하며 저장소에 넣지 않는다. HTTPS 전송과 별개로 Tauri 서명 검증은 필수이며 검증 실패 artifact는 설치하지 않는다.
- 프로세스 전역 `UpdateManager`가 current/available version, release notes/date, operation(`idle|checking|downloading|installing`), progress, 마지막 확인 시각, 오류의 단일 진실원이다. 동시에 하나의 확인 또는 설치만 진행하며 모든 표면은 같은 snapshot을 읽는다.
- release build는 시작 5초 뒤 확인하고 이후 6시간마다 다시 확인한다. 사용자는 데스크톱 상단 업데이트 버튼, Automation API, Remote Settings에서 즉시 확인할 수 있다. debug build는 개발 실행 파일을 release artifact로 바꾸지 않도록 self-update를 비활성화한다.
- 데스크톱은 업데이트가 있을 때만 상단 action을 표시한다. 설치를 누르면 대상 버전과 재시작을 확인받고, 다운로드·설치 진행 상태를 공통 event로 갱신한다.
- Automation은 `GET /api/v1/update`, `POST /api/v1/update/check`, `POST /api/v1/update/install`을 `Cache-Control: no-store` 응답으로 제공한다. 기존 Automation IP allowlist가 호출 권한이며 install은 별도 사용자 대화상자를 요구하지 않는다. 이 API를 사용할 수 있는 로컬 자동화 주체는 이미 앱 제어권을 가진 trusted operator로 본다.
- Remote는 `GET /remote/v1/update`, `POST /remote/v1/update/check`, `POST /remote/v1/update/install`을 제공한다. status/check는 기존 enabled + Direct bearer/IP/Origin 또는 Android E2E session/AEAD gate를 통과하면 controller lease 없이 허용한다. install은 같은 인증에 active controller `leaseId`를 추가로 요구한다. Remote Settings는 상태·릴리스 노트와 확인/설치 action을 표시하고 새 버전이 있으면 Settings 진입 버튼에 표시점을 붙인다.
- Remote install 권한은 요청 수락 시 owner gate의 mutation permit으로 선형화한다. 수락 뒤에는 updater가 release를 다시 확인하고 서명된 artifact를 내려받아 설치하며, 그 사이 lease가 만료되거나 재시작으로 연결이 끊겨도 작업을 취소하지 않는다. 수락 전에 release/reclaim/expiry가 시작되면 거절한다.
- Android native 앱은 updater 상태·키·artifact를 소유하거나 자기 APK를 갱신하지 않는다. Android E2E exact inner allowlist는 PC가 제공한 Remote UI가 위 세 endpoint를 호출할 수 있게 할 뿐이며 설치 대상은 항상 연결된 PC다.

## Alternatives Considered

- **GitHub Releases 페이지 링크만 연다.** 배포 인프라는 단순하지만 앱/Remote에서 최신 여부와 진행 상태를 알 수 없고 사용자가 PC에서 수동 설치해야 하므로 요구를 충족하지 못한다.
- **GitHub API를 직접 호출하고 asset을 실행한다.** 채널 선택은 유연하지만 업데이트 메타데이터·플랫폼 asset 선택·서명 검증·installer 실행을 독자 계약으로 다시 구현해야 한다. Tauri의 mandatory signature updater와 표준 `latest.json`을 사용한다.
- **사람이 먼저 Release를 발행하고 `release.published` CI가 검증한다.** event는 발행이 완료된 뒤 발생하므로 workflow 실패가 Release 발행이나 latest 지정을 원자적으로 되돌릴 수 없고, 병렬 artifact의 부분 성공도 이미 노출된다. 릴리스 생성 자체를 검증된 `workflow_dispatch`가 소유한다.
- **GitHub latest/prerelease 상태만 신뢰하고 앱은 버전과 tag를 검증하지 않는다.** 평상시 채널 선택에는 충분하지만 수동 Release 발행 실수가 즉시 모든 PC의 updater 입력이 된다. 클라이언트의 좁은 `x.y.z` manifest + `v?x.y.z` tag 일치 검증은 별도 채널을 선택하지 않고 명백히 잘못된 stable Release만 거절하므로 방어선으로 유지한다.
- **서명 없이 HTTPS와 GitHub 계정만 신뢰한다.** release asset 또는 배포 경로 침해가 바로 코드 실행으로 이어진다. 앱에 고정한 별도 updater key로 artifact provenance를 검증한다.
- **Remote install도 인증만 요구한다.** observer가 앱 재시작을 유발할 수 있어 기존 Remote mutation 경계보다 권한이 넓어진다. 상태/확인은 읽기 수준으로 두되 설치는 active lease로 제한한다.
- **install 전체 시간 동안 lease를 유지해야 한다.** 다운로드 중 모바일 네트워크 전환이나 프로세스 재시작 때문에 정상 업데이트가 실패하거나 반쯤 적용될 수 있다. 권한은 수락 시 고정하고 이후 작업은 독립적으로 완주한다.
- **Android APK도 같은 updater로 갱신한다.** 앱스토어 배포·서명·심사·인앱 업데이트 정책이 PC installer와 다르고 현재 요구 범위를 넘으므로 별도 후속 결정으로 남긴다.

## Consequences

- PC 앞에 없어도 Remote에서 새 버전을 발견하고 active controller가 설치·재시작을 시작할 수 있다. 재시작 동안 연결은 끊기며 Remote 페이지는 짧은 poll로 복귀한 프로세스를 다시 관측한다.
- Windows와 Linux release artifact, `latest.json`, artifact signature가 draft Release에 함께 올라가고 모든 필수 job이 성공해야만 게시된다. 어느 플랫폼 또는 stable Android build가 실패하면 draft가 남고 기존 latest는 유지된다.
- prerelease/nightly Release도 데스크톱 artifact를 만들 수 있지만 GitHub의 stable latest endpoint에는 나타나지 않는다. Android 배포 job은 stable 버전 태그 계약과 앱스토어 후속 범위를 지키기 위해 prerelease에서는 실행하지 않는다.
- updater private key를 잃으면 이미 배포한 앱이 새 artifact를 검증할 수 없다. GitHub secret 외의 접근 통제된 복구 백업과 키 회전 절차가 출시 운영의 필수 후속 작업이다. public key를 바꾸려면 기존 key로 서명한 bridge release를 먼저 배포해야 한다.
- 자동 확인 실패는 현재 확인된 update 정보를 지우지 않고 `lastError`로 남긴다. 네트워크가 복구되면 다음 주기나 수동 확인으로 갱신한다. 앱 내부 rollback과 다운로드 재개는 제공하지 않는다.
- Android store update는 여전히 미지원이다. 나중에 도입할 때 Play 인앱 업데이트와 GitHub APK 배포 정책, Android 장기 앱 서명 신원을 별도 ADR로 결정한다.
- 자동 검증은 상태 전이·동시 작업 배제, release/Remote/Automation route 등록, Remote lease gate와 Android exact allowlist, 데스크톱/Remote 표시, updater config와 release workflow를 포함한다. 실제 서명 artifact 설치·재시작은 staging GitHub Release에서 플랫폼별로 검증해야 한다.
