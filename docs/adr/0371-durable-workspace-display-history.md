# 0371. 워크스페이스의 마지막 표시와 제출 입력을 로컬 세션에 보존한다

- Status: Accepted
- Date: 2026-11-03
- Source: 종료 후 재시작 시 마지막 상태·사용자 입력 표시 및 workspace 진입 시 상태 갱신 요구, [data-flow.md §9·§13](../architecture/data-flow.md), [ADR-0329](0329-daemon-retains-workspace-display-context.md), [ADR-0360](0360-unknown-activity-and-event-recovery.md)
- Amends: ADR-0329의 데몬 종료 시 표시 문맥 폐기 정책과 ADR-0360의 초기 unknown 표시 정책을 로컬 표시 이력에 한해 확장한다.

## Context

표시 문맥은 데몬 메모리에만 있어 데몬까지 종료하면 아직 방문하지 않은 workspace가 unknown으로 표시되고 마지막 제출 입력도 사라진다. 지연 마운트를 유지하면서 이전 작업을 알아볼 수 있어야 한다. 이전 상태를 현재 실행의 관측으로 취급하거나 자동 입력·알림 근거로 사용해서는 안 된다.

## Decision

**마지막 표시 문맥과 제출 입력을 로컬 SQLite 세션의 UI 상태에 저장하고, 최신 관측이 올 때까지 표시 이력으로 투영한다.**

- UI의 `terminal-display-store`가 표시 이력을 소유하며 기존 session checkpoint가 workspace·dock의 살아 있는 terminal content ID와 profile에 맞는 문맥만 수집한다. portable settings·템플릿·내보내기에는 포함하지 않는다. 데몬 메모리 문맥은 GUI 재부착의 보완 경로로 유지한다.
- 로드 시 마운트되지 않은 workspace까지 표시 이력을 복원한다. unknown은 저장된 앱 표시를 지우지 않는다. 최신 앱 관측과 작업 관측(유휴 포함)이 저장된 표시보다 우선한다. 저장된 작업은 stale이며 live task·관측·알림 이력에 주입하지 않는다. clear·절전·자동 CWD·복원 대화 귀속의 근거로 사용하지 않는다.
- workspace/pane 진입·준비 완료는 기존 대상별 재확인 경로를 사용한다. 전체 workspace 스캔이나 새로운 주기 조회를 추가하지 않는다. 마지막 사용자 입력은 재확인에서 다시 조회하지 않고, 더 새로운 제출 입력이 생기기 전까지 원래 시각과 함께 유지한다.
- profile 변경·content 삭제 시 해당 이력을 저장하지 않는다. 기존 문맥의 입력 2048 code point·기타 문자열 512 code point 제한과 알림 이력 제거를 재사용한다. 기록할 때마다 live 값과 아직 방문하지 않은 이력을 합성한다. 표시 변경은 별도 revision으로 이전 commit의 재사용만 무효화한다. 표시 수집 후 도착한 애니메이션이 전체 귀속 관측·DB 저장을 재시도하게 하지 않으며, 종료·업데이트는 마지막으로 수집한 표시를 저장하고 진행한다.
- Windows·Linux 모두 동일한 로컬 세션 경계를 사용한다. DB 실패는 기존 checkpoint 오류 정책을 따르며 live 상태를 조작하지 않는다. 스키마 마이그레이션은 만들지 않는다.

## Alternatives Considered

- 데몬 메모리만 유지: 정상 종료 후 정보가 사라지므로 요구를 충족하지 못한다.
- 모든 workspace를 시작 시 마운트·조회: 지연 시작 정책을 깨고 불필요한 PTY·WSL 비용을 만든다.
- 저장된 작업을 live store에 복원: 오래된 상태로 clear·알림·절전을 판단하게 되어 기각한다.
- settings.json에 저장: 입력 이력이 portable 설정과 섞여 내보내지므로 로컬 DB를 선택한다.

## Consequences

데몬 수명과 관계없이 마지막 표시와 제출 입력이 이어진다. 입력 일부가 로컬 디스크에 남는 것이 새 정책이며 사용자의 보존 요구에 따른다. 아직 재확인하지 않은 상태는 과거 표시일 수 있고 현재 실행 여부를 보증하지 않는다. 삭제·profile 변경·새 입력·unknown 관측·실제 유휴 관측·데몬 미지원·재시작 왕복과 portable export 제외를 테스트한다. 표시 이력을 제어의 권위로 사용하려면 별도 결정이 필요하다.

버전 영향은 호환되는 표시·입력 보존 기능 추가이므로 minor다.
