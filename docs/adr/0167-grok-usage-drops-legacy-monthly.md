# 0167. Grok 사용량 닫힌 집합에서 레거시 monthly 행을 뺀다 (0156 Amend)

- Status: Accepted
- Date: 2026-08-16
- Source: 사용자 확인(현재 SuperGrok / Grok Build `/usage`에 Monthly limit가 없다), [ADR-0156](0156-grok-first-class-agent.md)
- **Amends:** ADR-0156 Usage 행 계약. 닫힌 집합에서 `monthly`를 제거하고 기본 `visibleRows`를 `["weekly"]`로 둔다. probe 경로·나머지 행 키·화면에 없는 키를 그리지 않는 규칙은 그대로다.

## Context

ADR-0156은 Grok `/usage` 화면의 닫힌 행 키를 `weekly` · `monthly` · `credits` · `payg`로 고정했다. 그 시점의 TUI와 옛 billing meter에는 `Monthly limit` 라벨이 있었다.

현재 SuperGrok / Grok Build 계정 한도는 공유 주간 풀이다. 1.0.4 `/usage` Usage limit 탭 실기 캡처는 `Weekly limit (SuperGrok)`만 그린다. 구독료가 월 단위인 것과 PAYG의 `$used / $cap per month` 문구는 계정 monthly 쿼터가 아니다. 설정 기본값과 Settings 체크박스에 `monthly`를 남겨 두면 없는 한도를 고를 수 있는 죽은 토글이 된다.

범위는 Grok usage 행 계약과 표시 선택이다. 비목표는 weekly/credits/payg 수집, probe 드라이브, 세션 복원, PAYG 월 금액 파싱을 바꾸는 것이다.

## Decision

**Grok 사용량 닫힌 집합은 `weekly` · `credits` · `payg`다. `monthly`는 스냅샷·설정·표시에서 제거한다.**

- 기본 `usage.grok.visibleRows`는 `["weekly"]`다. 잘못된·빈 값은 이 기본값으로 정규화한다. 저장된 `monthly`는 알 수 없는 키로 버린다.
- `/usage`에 옛 `Monthly limit` 블록이 남아 있어도 스냅샷 행을 만들지 않는다. 라벨은 섹션 경계로만 써서 인접 weekly/credits 값을 삼키지 않는다.
- `credits`와 `payg`는 계속 선택 가능한 행이다. PAYG의 `per month` 금액 비율은 `payg`로 남긴다.

## Alternatives Considered

- **`monthly`를 설정에만 남기고 화면이 없으면 그리지 않는다.** ADR-0156의 기존 규칙이다. Settings에 죽은 토글이 남고 기본 선택에 없는 한도가 들어간다. 기각.
- **billing API의 옛 monthlyLimit를 다시 읽는다.** 현재 강제 한도는 weekly 풀이다. 레거시 미터를 되살리면 계정 한도와 다른 숫자를 보여 준다. 기각.
- **PAYG `per month`를 monthly로 승격한다.** 추가 결제 캡과 구독 쿼터를 한 키로 합친다. ADR-0156이 이미 거부한 합치기다. 기각.

## Consequences

Settings·UsageView·위젯·REST/MCP 스냅샷에서 Grok monthly 행이 사라진다. 구 `settings.json`의 `monthly`는 다음 로드에서 빠지며 남은 유효 키가 없으면 weekly만 표시한다. 상류가 계정 monthly 쿼터를 다시 `/usage`에 그리면 이 결정을 재검토한다.
