# 0173. Remote 표시 설정은 PC가 소유하고 양쪽 설정 UI가 편집한다

- Status: Proposed
- Date: 2026-08-17
- Source: 사용자 요구("Remote 전용 터미널 화면·입력 컴포저 글자 크기를 Remote와 PC에서 조회·수정") · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0015](0015-remote-terminal-state-ownership.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)

## Context

Remote 터미널 글자 크기는 데스크톱 profile 폰트 크기를 따르고, 입력 컴포저 글자 크기는 Remote 자산의 고정 CSS 값이었다. Remote 페이지의 기기 로컬 설정과 PC Settings의 연결 설정 중 어디에도 두 값을 함께 조회하거나 바꿀 수 있는 전용 영역이 없었다.

두 값은 Remote 표면에만 적용되지만 브라우저별 `localStorage`로 두면 PC에서 현재 값을 알 수 없고 여러 Remote 클라이언트가 서로 다른 값을 갖는다. 반대로 기존 `원격` PC 설정 페이지에 표시 옵션까지 넣으면 접속·인증 정책과 화면 정책의 책임이 섞인다. Android 앱은 PC가 제공한 동일 Remote 문서를 실행하므로 별도 APK 설정 정본을 만들어서도 안 된다.

범위는 Remote 터미널 화면과 입력 컴포저의 글자 크기다. 글꼴 face, 데스크톱 TerminalView/Composer의 크기, 기기 로컬 위젯 스트립 표시와 소프트 키 설정은 바꾸지 않는다.

## Decision

**Remote 터미널 화면·입력 컴포저 글자 크기의 단일 정본은 PC의 `settings.remote`이고, Remote 페이지와 PC의 별도 `원격 화면` 설정 페이지가 같은 값을 편집한다.**

- `remote.terminalFontSize`와 `remote.composerFontSize`를 영속 설정으로 두며 기본값은 기존 Remote 표면과 같은 14px, 허용 범위는 8–32px다.
- PC Settings의 기존 `원격` 페이지는 `원격 연결`로 명확히 이름 붙이고 접속·인증·Cloud 수명주기 설정만 유지한다. 새 `원격 화면` 페이지가 두 글자 크기와 기존 Remote 전용 휠·터치 민감도, 폰트 전송, 위젯 표시를 함께 소유한다.
- 인증된 `GET /remote/v1/display-settings`는 두 값만 반환한다. `PATCH /remote/v1/display-settings`는 active controller lease를 요구하고 두 값만 수정한다. bearer 인증만 가진 observer는 조회할 수 있지만 PC 영속 설정을 바꿀 수 없다.
- PATCH는 기존 settings bridge를 통해 PC 프런트 설정 store, settings.json, Remote runtime을 한 번에 갱신한다. 별도 파일이나 브라우저 저장소를 만들지 않는다.
- Remote 페이지는 PATCH 성공 응답을 즉시 현재 xterm과 composer에 적용한다. 터미널 크기 변경은 기존 fit 정책을 재실행한다.
- Android E2E는 동일한 두 HTTP 경로를 고정 allowlist에 넣고 PC 제공 Remote 문서를 그대로 사용한다. APK에 중복 설정 모델이나 UI를 추가하지 않는다.

## Alternatives Considered

### 브라우저별 `localStorage`

Remote에서 즉시 구현하기 쉽지만 PC가 값을 조회·수정할 수 없고 클라이언트마다 설정이 갈린다. 단일 정본 요구를 만족하지 못해 기각한다.

### 기존 `원격 연결` 페이지에 표시 옵션 추가

영속화 경로는 단순하지만 접속 보안 정책과 Remote 화면 정책이 같은 UI에 섞인다. 사용자가 연결 설정과 표시 설정을 명시적으로 분리해 달라고 했으므로 기각한다.

### 데스크톱 profile 폰트 크기를 계속 상속

추가 스키마가 없지만 Remote 전용 화면 크기를 독립적으로 조절할 수 없다. 입력 컴포저와도 하나의 Remote 표시 계약을 만들 수 없어 기각한다.

### Remote bearer 인증만으로 수정 허용

연결 URL을 가진 observer도 PC의 영속 설정을 바꿀 수 있다. 표면 표시 변경도 host 상태 변경이므로 기존 controller lease 권한 경계와 맞지 않아 기각한다.

## Consequences

- Remote와 PC가 같은 두 값을 보여주고 수정하며, 브라우저·Android transport에 따라 설정이 갈리지 않는다.
- 설정 스키마와 Remote API가 확장되므로 Rust/TypeScript 모델, semantic validation, 설정 메타데이터, Direct/Android E2E 경로 테스트를 함께 유지해야 한다.
- Remote 글자 크기는 더 이상 profile별 데스크톱 크기를 상속하지 않는다. 기본 14px로 현재 일반 동작을 보존하지만 사용자 지정 profile 크기와 Remote 크기는 독립된다.
- PATCH는 데스크톱 프런트 settings bridge가 응답할 수 있어야 한다. 프런트가 비정상이면 설정을 일부만 저장하지 않고 요청 전체를 실패시킨다.
- 여러 Remote 클라이언트에 대한 별도 push 채널은 만들지 않는다. 수정한 클라이언트는 즉시 반영하고, 다른 클라이언트는 다음 설정 조회나 재접속에서 PC 정본을 받는다. 동시 실시간 동기화가 필요해지면 settings revision/event 계약을 후속 결정으로 검토한다.
