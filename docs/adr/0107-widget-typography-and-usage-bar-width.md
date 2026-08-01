# 0107. 위젯 글꼴은 전역 표시 설정이, 사용량 막대 너비는 인스턴스 옵션이 소유한다

- Status: Accepted
- Date: 2026-08-01
- Source: 사용자 요구(설정 UI에서 위젯 글꼴·크기와 사용량 위젯 width 조정); `docs/architecture/api-contracts.md` §10 Settings·§15 UI 코드 설계 원칙; [ADR-0004](0004-settings-vs-ui-state-separation.md), [ADR-0032](0032-llm-settings-introspection-and-safe-mutation.md), [ADR-0105](0105-widget-slots-and-status-line.md)
- Extends: [ADR-0105](0105-widget-slots-and-status-line.md) — 위젯 공용 typography와 사용량 위젯의 가로 표현 옵션을 추가하되 슬롯 배치·접힘·원자성 계약은 유지한다.

## Context

상단 바와 status line의 모든 위젯은 현재 인터페이스 글꼴과 9px 글자 크기를 고정적으로 상속한다. 사용자는 화면 배율과 시력, 위젯을 보는 거리에 맞춰 이를 조정할 수 없다. 사용량 위젯의 consumed/elapsed 막대도 26px로 고정되어, 숫자를 함께 보는 조밀한 배치와 막대 추세를 멀리서 읽는 배치 사이를 선택할 수 없다.

글꼴을 위젯 인스턴스마다 두면 같은 한 줄에서 서로 다른 typography가 섞이고 설정 UI가 반복된다. 반대로 사용량 막대 너비를 전역으로 두면 상단 바와 status line에 같은 계정을 함께 놓는 정상 배치가 서로 다른 가독 거리에도 같은 폭을 강제받는다.

ADR-0105는 슬롯이 설정에서 계산한 요구 폭으로 접힘을 판정하고 위젯을 원자적으로 표시하도록 정했다. 따라서 사용자가 말한 width를 위젯 전체의 임의 고정 폭으로 해석해 콘텐츠를 자르면 기존 불변식과 충돌한다. 이번 결정의 범위는 데스크톱 위젯의 공용 글꼴·크기와 사용량 막대의 가로 길이다. pane `UsageView`, 원격 UI, 사용자 정의 위젯 플러그인은 비목표다.

## Decision

**모든 데스크톱 위젯의 글꼴·글자 크기는 `settings.widgets`가 공용으로 소유하고, 사용량 막대 너비는 각 사용량 위젯 인스턴스의 `options.barWidth`가 소유한다.**

- `widgets.fontFamily`는 문자열이며 빈 값이면 `appearance.uiFontFamily`가 정한 인터페이스 글꼴을 상속한다. 기본값은 빈 문자열이다.
- `widgets.fontSize`는 모든 상단 바·status line 위젯과 Settings 미리보기에 적용되는 픽셀 값이다. 기본값은 기존 표시와 같은 9px, 허용 범위는 6~20px다.
- 글자 크기가 바뀌면 슬롯의 요구 폭 계산도 같은 설정값을 입력으로 받아 함께 커진다. 렌더된 DOM 폭을 다시 읽어 예산을 정하지 않으므로 ADR-0105의 접힘 피드백 방지 원칙을 유지한다.
- `claudeUsage`와 `codexUsage` 인스턴스는 `options.barWidth`를 갖는다. 기본값은 기존 표시와 같은 26px, 허용 범위는 8~200px다. consumed와 elapsed track은 항상 같은 너비를 쓴다.
- 사용량 위젯의 슬롯 요구 폭은 `barWidth`, 표시 방식, 전역 표시 행 수, 공용 글자 크기에서 계산한다. 설정한 막대 폭과 접힘 예산이 갈라지지 않는다.
- 쓰기 경로는 범위를 벗어나거나 정수가 아닌 `fontSize`·`barWidth`를 [ADR-0032](0032-llm-settings-introspection-and-safe-mutation.md)에 따라 거부한다. 프론트 렌더러는 손편집된 기존 파일의 잘못된 수치를 안전 범위로 clamp해 한 줄 표면을 깨뜨리지 않는다.
- 기존 설정에는 새 키가 없으므로 serde/frontend 기본값으로 현재 화면을 그대로 재현한다. 별도 마이그레이션은 하지 않는다.

## Alternatives Considered

- **글꼴과 크기를 위젯 인스턴스마다 저장.** 서로 다른 정보 유형에 개별 가독성을 줄 수 있지만 한 줄의 baseline과 밀도가 깨지고, 모든 위젯 상세 설정에 같은 항목이 반복된다. 사용자의 “위젯 공용” 의도에도 맞지 않는다.
- **글꼴 설정을 `appearance`에 추가.** 앱 크롬과 위젯이 같은 글꼴을 쓰는 기본값은 자연스럽지만, 위젯만 더 크거나 다른 고정폭 글꼴로 보고 싶은 요구를 표현할 수 없다. 빈 `fontFamily` 상속으로 기본 연계만 유지한다.
- **사용량 위젯 전체에 고정 `width` 적용.** 사용자가 말한 width를 문자 그대로 표현하지만 표시 행 수·숫자 유무에 따라 내부가 잘릴 수 있어 ADR-0105의 원자적 위젯 계약과 충돌한다.
- **막대 너비를 provider 전역 설정으로 저장.** 설정은 단순하지만 같은 provider를 상단 바와 status line에 놓았을 때 서로 다른 가독 거리를 반영할 수 없다. 기존 막대 두께와 마찬가지로 배치 인스턴스가 소유하는 편이 일관된다.
- **글자 크기 변화 후 DOM을 측정해 슬롯 폭 결정.** 실제 폭에는 가깝지만 접힘 결과가 측정 폭을 다시 바꾸는 피드백을 만들며 ADR-0105가 금지한 불안정한 소유권으로 돌아간다.

## Consequences

- Settings → Interface → 위젯에서 모든 위젯의 글꼴과 글자 크기를 한 번에 조정할 수 있고, 선택 전 미리보기에도 즉시 반영된다.
- 사용량 위젯마다 막대를 조밀하게 줄이거나 멀리서 읽기 쉽게 늘릴 수 있으며, 슬롯은 그 폭을 사전에 예산에 반영한다.
- `settings.json` 외부 계약에 `widgets.fontFamily`, `widgets.fontSize`, 사용량 위젯 `options.barWidth`가 추가된다. frontend 기본값/reader, Rust serde 기본값/semantic validation, Settings UI가 같은 범위와 기본값을 유지해야 한다.
- 큰 글자나 넓은 막대는 위젯이 더 일찍 overflow로 접히게 한다. 이는 사용자가 요청한 표시 크기에 필요한 공간을 숨기지 않고 반영한 결과다.
- 글꼴 실제 glyph 폭과 계산 예산은 완전히 같지 않을 수 있다. 추정 오차가 실사용에서 원자성을 해칠 정도로 드러나면 DOM 측정이 아니라 설정 기반 글꼴별 보수 계수를 검토한다.
