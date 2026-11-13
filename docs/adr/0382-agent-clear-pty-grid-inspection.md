# 0382. 에이전트 지우기는 실제 PTY 격자의 미러 화면을 검사한다

- Status: Proposed
- Date: 2026-11-13
- Source: 사용자 보고(첫 실행 후 Remote Claude·Codex 지우기 실패), dev Remote Claude 재현(PTY 81열·PC 26열), [ADR-0355](0355-agent-hook-results-and-clear-drafts.md), [ADR-0069](0069-remote-render-checkpoint-attach.md), architecture/overview.md §4.1.1
- 관계: ADR-0355의 현재 입력창 검증 원칙을 유지하며, 화면 근거를 PC 표시 격자에서 실제 PTY 격자로 명확히 한다.

## Context

Remote 제어 중 PTY는 리모트 화면 크기로 실행되지만 PC의 visible xterm은 데스크톱 pane 크기를 유지한다. PC 버퍼로 입력창을 검사하면 리모트에서 정상인 테두리·프롬프트·footer가 잘리거나 여러 줄로 갈라진다. 실제 dev에서 Claude 입력창이 리모트 81열에서는 정상인데 PC 26열에서는 미지원으로 판정되어 첫 지우기가 실패했다. Codex 첫 세션의 context 없는 사용자 지정 상태줄도 별도로 거부됐다.

입력창 검사를 생략하면 초안 뒤에 `/clear`를 붙이거나 모달에 제출할 수 있다. 표시 pane을 강제로 확대하거나 리모트 크기를 바꾸는 해결도 사용자 레이아웃과 PTY 재그리기에 영향을 준다. 기존 Remote attach용 rendererless 미러는 이미 동일 PTY 출력과 실제 geometry를 순서대로 파싱하므로 이를 재사용한다. 상태 권위·입력 소유권·busy 정책 변경은 범위 밖이다.

## Decision

**에이전트 지우기의 입력창 검증은 실제 PTY 격자로 파싱하는 기존 rendererless checkpoint 미러의 현재 viewport를 사용한다.**

- 미러의 inline·Worker 구현 모두 이미 수락한 출력 FIFO 뒤에서 viewport 셀과 generation·source sequence를 읽는다. 새 미러나 화면 상태 저장소는 만들지 않는다.
- 지우기는 비동기 판독 전후에 기존 대상·작업 상태·deadline을 확인하고, 화면 generation이 입력 receipt의 세대와 같은지 검사한다. 미러 부재·재구성 불가·실패·시간 초과에는 PC visible 버퍼로 대체하지 않는다.
- PC inspector는 기존 화면 진단 용도로 유지한다. PC와 Remote의 표시 격자 및 PTY 크기를 지우기 때문에 변경하지 않는다.
- 초안 전체 삭제·180ms 빈 입력창 확인·3초/32회 한도와 Rust의 generation·입력 revision·Remote lease 검사는 유지한다. 첫 세션에서 context가 없는 Codex 모델 footer도 지원하는 텍스트 입력창으로 판독한다.
- 외부 REST/MCP 응답, 설정, 인증·포트, Windows·WSL의 입력 경로는 변경하지 않는다.

## Alternatives Considered

- PC visible 버퍼 판독 유지: PTY와 격자가 다르면 입력창의 실제 셀 구조를 증명하지 못한다.
- PC 버퍼를 리모트 크기로 임시 변경: 이미 잘못 파싱한 cursor-addressed 출력의 의미를 일반 reflow만으로 복원할 수 없고 화면 깜빡임·resize 경합을 만든다.
- Remote가 입력창 판정 결과를 보냄: 클라이언트별 구현과 신뢰 경계가 늘며 Local·Automation에서 같은 검증을 공유하기 어렵다.
- 입력창 검사 생략 또는 Ctrl+C 강제 전송: 미제출 초안 보존·모달 안전성·기존 busy 정책을 훼손한다.

## Consequences

PC pane 폭과 무관하게 실제 리모트 입력창을 판독한다. 판독마다 제한된 viewport를 Worker IPC로 전달하는 비용과 비동기 수명 검증이 추가된다. 미러가 재구성되지 않았거나 실패한 경우에는 계속 보수적으로 지우기를 거부한다. 마이그레이션은 없으며 실제 Remote 첫 실행 재현, inline/Worker 셀 일치, 초안 삭제, 세대 교체·판독 중 deadline 회귀를 검증한다. 향후 CLI가 구조화된 대화 초기화 API를 제공하면 화면 판독 필요성을 재검토한다.
