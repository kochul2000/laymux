# 0056. Remote crop 창은 화면 바닥이 아니라 live tail 에 정렬한다

- Status: Proposed
- Date: 2026-07-25
- Source: 사용자 보고(remote 에서 출력이 적을 때 키보드를 열면 내용이 위로 몰리고 아래 10 줄이 빈다) · [ADR-0038](0038-remote-height-shrink-surface-crop.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Relation: [ADR-0038](0038-remote-height-shrink-surface-crop.md) 의 crop 정렬 규칙(하단 정렬 + 커서 보정)을 정정·확장한다. 높이 축소를 surface 로컬로 재분류한다는 결정 자체는 그대로다.

## Context

ADR-0038 은 폭 불변 높이 축소에서 PTY geometry 를 보존하고 sizer 를 마지막 fit 픽셀 높이로 고정해 **host 하단에 정렬(bottom-anchored)** 하도록 정했다. "하단이 live tail" 이라는 전제는 버퍼가 이미 스크롤된 뒤에만 성립한다. 아직 스크롤되지 않은 버퍼(세션 시작 직후, `clear` 직후, 출력이 화면보다 적을 때)는 내용이 화면 상단 몇 행에만 있고 그 아래는 빈 행이다. 이때 하단 정렬은 **빈 행 구간을 crop 창에 넣는다** — 소프트 키보드를 열면 프롬프트와 상태 줄이 창 위로 밀려나고 composer 위에 빈 줄 10 여 개가 남는다. 커서 보정은 커서 행을 창 **상단**에 겨우 걸치게만 만들므로, 커서 아래에 그려지는 TUI 요소(Claude Code 의 구분선·권한 힌트 줄)와 빈 꼬리가 그대로 창을 채운다. 출력이 화면을 채운 뒤에는 증상이 사라진다.

crop 창이 어느 슬라이스를 보여줄지는 surface 로컬 표시 정책이므로 PTY 계약과 무관하게 정할 수 있다. 결정이 필요한 이유는 "하단 정렬"이 정렬 기준을 화면 바닥으로 고정해 이 경우를 구조적으로 배제하기 때문이다.

범위는 remote surface 의 crop 창 정렬과 그로 인해 노출되는 clipping wrapper 의 배경뿐이다. 비목표: 높이 축소를 PTY 에 전파하는 정책 복귀, 데스크톱 `TerminalView`, alternate buffer 취급, crop 중 PTY 로 보존 geometry 를 재전송하는 규칙 — 모두 ADR-0038 그대로다.

## Decision

**crop 창은 화면 바닥이 아니라 live tail 행에 정렬한다.** tail 행 = 커서 행과, 커서 아래의 마지막 비어 있지 않은 렌더 행 중 아래쪽. tail 행 아래의 빈 행은 crop 창 밖(아래)으로 밀어낸다.

- tail 정렬에 필요한 이동량이 잘려 있던 높이보다 크면 sizer 상단이 host 상단보다 내려간다. 빈 꼬리가 존재한다는 것은 버퍼가 한 번도 스크롤되지 않았다는 뜻이므로 화면 위로 밀려 사라지는 내용은 없다.
- 이때 노출되는 clipping wrapper 는 활성 터미널의 xterm 테마 배경으로 칠한다. 노출 영역은 "빈 터미널 화면"으로 읽혀야 하며, 셸 고정 배경(`--terminal-bg`)이 아니라 터미널별 appearance 배경이 SoT 다.
- 커서 행 가시성 보장(ADR-0038)은 유지한다. 커서 행이 tail 정렬로도 창 위에 남는 경우(커서와 tail 사이가 창 높이보다 긴 경우)에만 커서 보정이 우선한다.
- tail 은 커서 이동뿐 아니라 렌더·스크롤로도 바뀐다. 재계산은 crop 이 활성일 때만, 프레임당 한 번으로 합친다. crop 이 없으면 transform 은 identity 로 되돌아간다.
- 출력이 화면을 채워 tail 이 마지막 행이면 결과는 ADR-0038 의 하단 정렬과 동일하다(행 내림으로 생기는 sizer 하단 여백만큼은 걷어내 uncropped 레이아웃과 같은 여백을 유지한다).

## Alternatives Considered

- **커서 행을 창 하단에 정렬**: 커서 아래에 그려지는 TUI 요소(Claude Code 의 힌트 줄)가 잘린다. tail 을 "커서 또는 그 아래 마지막 비어 있지 않은 행"으로 정의해야 프롬프트 아래 UI 가 보인다.
- **빈 꼬리만큼 이동하되 잘린 높이 이내로 제한(sizer 를 host 밖으로 내보내지 않음)**: 이동 상한이 키보드 높이라 빈 꼬리가 그보다 길면 여전히 빈 줄이 남는다. 사용자 보고 사례가 정확히 이 구간이다.
- **crop 시 sizer 높이를 tail 까지로 줄이기**: xterm 은 `rows × cellHeight` 를 렌더하므로 sizer 를 줄이면 내부 뷰포트가 스크롤 가능해지고 자동 하단 스크롤로 빈 꼬리가 다시 노출된다. 표시 슬라이스는 transform 으로 고르는 것이 xterm 내부 스크롤과 충돌하지 않는다.
- **빈 꼬리를 없애려 rows 를 줄여 PTY 에 전파**: ADR-0038 이 막으려던 scrollback reflow flood 를 되살린다.
- **노출 영역을 셸 배경(`--terminal-bg`)으로 두기**: 터미널 appearance 배경이 기본값과 다르면 화면 상단에 색 띠가 보인다.

## Consequences

- 출력이 적은 상태에서 소프트 키보드를 열면 내용이 composer 바로 위에 붙어, 프롬프트와 상태 줄을 보면서 입력할 수 있다. 출력이 화면을 채운 뒤의 동작은 이전과 같다.
- crop 중 tail 위쪽에 터미널 배경 영역이 생긴다(빈 행을 아래에서 위로 옮긴 것과 같다). 노출 영역은 터미널 테마 배경이라 시각적으로 빈 화면과 구분되지 않는다.
- crop 중에는 렌더·스크롤마다 tail 재측정(레이아웃 강제)이 프레임당 1 회 발생한다. crop 이 아닐 때는 비용이 없다. 대량 출력 중 소프트 키보드가 열려 있는 동안에만 해당한다.
- crop 중 스크롤백을 위로 스크롤하면 렌더 행이 채워져 정렬이 하단 정렬로 돌아가며 내용이 한 번 내려앉는다. 스크롤 위치는 여전히 surface 로컬이다.
- `--terminal-surface-bg` 가 활성 터미널 appearance 를 따라가는 새 표시 상태로 추가된다. 터미널 전환·appearance 갱신 경로가 이 값을 갱신할 의무를 진다.
- 재검토 조건: remote 가 Full UI(React bundle)로 전환되어 데스크톱 fit 스케줄러(ADR-0026)를 공유하게 되는 시점, 또는 xterm 이 화면 슬라이스 표시 API 를 제공하는 시점.
