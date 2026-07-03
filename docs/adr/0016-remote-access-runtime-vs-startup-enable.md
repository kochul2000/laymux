# 0016. Remote Access 활성화는 런타임 허용과 시작 시 허용을 분리한다

- Status: Accepted
- Date: 2026-07-01
- Source: Remote Access 버튼은 "이번 실행 동안만 허용"과 "시작 시 자동 허용"을 구분해야 한다는 사용자 요구

## Context

Direct Remote Mode는 브라우저가 laymux를 직접 제어할 수 있는 네트워크 표면이다. 기존 `settings.remote.enabled`는 `settings.json`에 저장되는 영속 설정이므로, 한 번 켜면 다음 실행에서도 `/remote/` entry가 열린다.

Remote Access 버튼을 단순 영속 토글로 만들면 사용자가 "지금 한 번만 다른 장치에서 붙기 위해 켠" 경우에도 이후 실행마다 remote 표면이 열린다. 반대로 매번 허용해야 하는 방식만 제공하면 항상 원격 접속이 필요한 사용자에게 불편하다. 따라서 보안 기본값과 반복 사용성을 동시에 만족하려면 두 경로를 분리해야 한다.

적용되는 force:

- Remote 인증 토큰과 IP allowlist를 갖춰도 네트워크 표면을 여는 행위 자체는 명시적이어야 한다([ADR-0013](0013-direct-remote-mode.md)).
- `settings.json`은 사용자가 의도적으로 선택한 구성이고, "이번 실행 동안만 같은 일회성 권한"은 설정 파일에 저장되지 않아야 한다([ADR-0004](0004-settings-vs-ui-state-separation.md)).
- remote page, vendor asset, `/remote/v1/*` API는 같은 gate를 사용해야 한다. entry만 열리고 API가 막히거나 그 반대가 되면 안 된다.

## Decision

Remote Access 활성화는 두 경로로 분리한다.

- **이번 실행 동안 허용**: `AppState`의 런타임 상태에만 저장한다. 프로세스가 종료되면 사라지고 `settings.json`에는 기록하지 않는다.
- **시작 시 자동 허용**: 기존 `settings.remote.enabled`를 사용하며 `settings.json`에 저장한다.

remote의 유효 활성 상태는 `settings.remote.enabled || runtimeRemoteAccess.enabled`로 계산한다. remote 인증 토큰은 기존 `settings.remote.authToken`을 우선 사용하고, 영속 토큰이 비어 있을 때만 런타임 허용 토큰을 사용한다. IP allowlist, Origin 정책, heartbeat timeout은 기존 `settings.remote` 계약을 따른다.

모든 remote entry point(`/remote`, `/remote/`, `/remote/vendor/*`, `/remote/v1/*`)는 유효 설정을 같은 함수로 계산해 접근을 제어한다. 런타임 허용이 꺼지고 영속 허용도 꺼진 경우 기존 controller lease를 해제한다.

## Consequences

- 사용자는 일회성 원격 접속을 허용해도 다음 실행에서 remote 표면이 자동으로 열리지 않는다.
- 상시 원격 접속이 필요한 사용자는 별도 "시작 시 자동 허용"을 켜야 한다.
- `settings.json`의 `remote.enabled` 의미는 "시작 시 자동 허용"으로 좁아진다. 런타임 허용 상태는 설정 파일과 세션 영속 대상이 아니다.
- Remote Access UI는 유효 상태, 런타임 허용, 시작 시 허용을 구분해 보여줘야 한다.
- remote 접근 제어는 설정만 읽지 않고 `AppState` 런타임 상태도 참조한다. 따라서 remote router/page/asset/middleware는 서버 상태를 주입받아 동일한 계산 함수를 사용해야 한다.
