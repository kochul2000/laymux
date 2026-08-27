# 0199. Remote 메뉴(내비게이션 드로어) 글자 크기를 PC 소유 display-settings 계약에 추가한다

- Status: Superseded by [0209](0209-remote-display-preferences-are-device-local.md)
- Date: 2026-08-24
- Source: 사용자 요구("remote 에서 메뉴 폰트 크기조정 기능 만들어줘") · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0173](0173-remote-display-settings-pc-owned-and-lease-gated.md) · [ADR-0177](0177-remote-two-finger-touch-scroll-sensitivity.md)
- Extends: ADR-0173

## Context

ADR-0173 은 Remote 표시 글자 크기(terminal cell, 입력 composer)를 PC의 `settings.remote` 가 소유하고, Remote 조회는 기존 접속 인증을, 영속 변경은 active controller lease 를 요구하는 `/remote/v1/display-settings` projection·PUT 계약으로 고정했다. 그러나 Remote 내비게이션 드로어(메뉴 — workspace 목록, 알림, 설정 화면)의 글자 크기는 여전히 CSS 고정값이었다. 드로어는 `--fs-xs`(10px)·`--fs-sm`(11px)·`--fs-md`(13px) 전역 토큰과 workspace 목록의 개별 px 값(9~14px)을 섞어 쓰고 있어, 휴대폰에서 터미널·composer 크기를 키운 사용자도 메뉴 텍스트는 조정할 수 없었다.

터미널·composer 와 같은 이유로 이 값도 기기-로컬 상태로 둘 수 없다: PC Settings 와 여러 Remote 클라이언트(Direct browser, Android E2E)가 같은 값을 읽고 바꿔야 한다. 남은 결정은 (a) 설정 키·소유권을 ADR-0173 계약에 어떻게 편입하는지, (b) 하나의 기준값이 서로 다른 크기 tier(10/11/13px 토큰 + 개별 px)를 어떻게 일관되게 스케일하는지다.

범위는 Remote 드로어의 글자 크기 소유권·계약·스케일 방식이다. 드로어 밖 표면(header, key bar, 위젯 strip, 터미널, composer)과 데스크톱 앱 자체의 메뉴 크기는 비목표다.

## Decision

**Remote 메뉴 글자 크기는 새 키 `settings.remote.menuFontSize`(기본 13, 6~72 정수)로 PC 가 소유하며, ADR-0173 의 display-settings projection·PUT 계약에 같은 인증·lease·CAS 규칙으로 실린다.**

- 기본값 13 은 드로어의 기존 본문 기준(`--fs-md`, body 13px)과 같으므로 기존 설치본은 픽셀 단위로 동일하게 렌더된다. 내부 개발 단계 정책에 따라 마이그레이션은 없다.
- `GET/PUT /remote/v1/display-settings` projection 에 `menuFontSize` 필드를 추가한다. 인증·lease·`expectedRevision` CAS·409 재조회 규칙은 ADR-0173 을 그대로 따르고 확장하지 않는다.
- 적용 방식은 composer 와 같은 CSS 변수 한 개다: 클라이언트가 `--remote-menu-font-size` 를 문서 루트에 쓰고, 드로어(`.navigation-panel`) 스코프에서 `--fs-md` 는 기준값, `--fs-xs`/`--fs-sm` 은 10/13·11/13 비율 `calc()` 로 재유도한다. 전역 토큰 자체는 바꾸지 않으므로 드로어 밖 표면은 영향받지 않는다.
- 드로어 안에서 px 로 고정돼 있던 workspace 목록 텍스트(이름·인덱스·활동·요약 등)는 기준값에 비례하도록 전환해 함께 스케일한다. 패널 기준값을 그대로 상속하는 요소는 em 을 쓰고, 부모가 `--fs-sm` 등 다른 크기를 가진 요소(활동 pill, dock 위치·명령 상태 배지)는 em 이 부모 기준으로 어긋나므로 `calc(var(--remote-menu-font-size) * N / 13)` 로 직접 유도한다. count 배지는 긴 숫자 축소를 위해 JS 가 인라인 font-size(px)를 쓰던 것을 축소 배율 커스텀 프로퍼티(`--count-badge-scale`)로 바꾸고, 크기의 SoT 는 CSS(`--count-badge-base`)에 남긴다 — 드로어 안에서는 메뉴 기준값을 따르고, 같은 배지 클래스를 쓰는 key bar 는 기존 10px 기본을 유지한다.
- PC Settings ▸ Remote Display 와 Remote 드로어 Display 섹션 양쪽에 같은 값을 노출한다(ADR-0173 의 편집 표면 규칙 그대로).

## Alternatives Considered

- **기기-로컬 `localStorage`.** 메뉴 크기는 보는 기기 취향이라는 논리도 있으나, PC Settings 와 양방향 편집·여러 클라이언트 일관성이라는 ADR-0173 의 결정 근거가 동일하게 적용된다. 계약을 둘로 가르는 비용이 더 크므로 기각.
- **드로어에 CSS `zoom`/`transform: scale()` 적용.** 필드 하나로 끝나지만 레이아웃 폭·터치 타깃·스크롤 계산이 함께 왜곡되고 브라우저별 렌더 차이가 크다. 기각.
- **전역 `--fs-*` 토큰을 직접 키운다.** 드로어 밖 header·key bar·위젯 strip 까지 같이 커져 "메뉴" 요구 범위를 넘고, 각 표면의 독립 조정(ADR-0173 의 표면별 분리 원칙)과 어긋난다. 기각.
- **tier 별 개별 설정(제목/본문/보조 각각).** 자유도는 높지만 설정 3~4개가 늘고 사용자는 비율이 아니라 전체 크기를 원한다. 기준값 하나 + 고정 비율로 충분. 기각.

## Consequences

- Direct browser 와 Android E2E 가 같은 PC 설정과 같은 Remote 문서를 쓰므로 메뉴 크기가 경로별로 갈리지 않는다.
- PUT body 필수 필드가 하나 늘어난다. 클라이언트 페이지는 같은 서버가 서빙하므로 구/신 혼재는 없다(내부 개발 단계, 마이그레이션 없음).
- 드로어 텍스트가 토큰 재유도·em·calc 로 묶였으므로, 이후 드로어에 px 고정 글자 크기를 새로 넣으면 이 결정과 어긋난다 — 드로어 안 신규 텍스트는 토큰이나 em 을 쓰되, 부모 font-size 가 패널 기준값이 아닌 자리에서는 menu 변수 기준 calc 를 쓴다.
- 배지 크기 SoT 가 JS 인라인 px 에서 CSS 커스텀 프로퍼티로 이동했다. 배지 축소 ladder 를 바꿀 때는 JS 배율만 조정하면 된다.
- 검증: Rust projection/clamp 단위 테스트, page.html 계약 테스트, Playwright e2e(조회·저장·즉시 적용·409 재조회), 데스크톱 SettingsView/스토어 테스트를 같은 PR 에서 확장한다.
