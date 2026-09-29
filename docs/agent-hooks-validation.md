# 선택형 에이전트 훅 검증

## 설치·제거 기반 (2026-09-29)

설계: [ADR-0282](adr/0282-optional-agent-hook-installation.md). 이 단계는 훅 관리와 연결 진단을 추가하며 활동·종료 체크포인트는 기존 판정을 유지한다. 상태 감지 선택은 별도 PR 범위다.

실기 환경은 격리된 dev(19281), Windows PowerShell과 WSL Ubuntu-22.04, 두 환경의 Codex 0.158.0·Claude Code 2.1.284다. 사용자 기본 설정을 수정하지 않고 별도 CLI 설정 폴더로 설치했다. Codex가 표시한 두 생명주기 훅의 신뢰 확인을 통과한 뒤 실행했다.

| 검증 | Windows Codex | WSL Codex | Windows Claude | WSL Claude |
| --- | --- | --- | --- | --- |
| 설치·조회·제거·재설치 API | 통과 | 통과 | 통과 | 통과 |
| 새 대화 SessionStart 수신 | 첫 입력 후 수신 | 첫 입력 후 수신 | 시작 때 수신 | 시작 때 수신 |
| 동일 대화 resume | 첫 입력 후 재수신 | 재연결 성공, 시작 이벤트 재수신 없음 | 같은 ID 재수신 | 같은 ID 재수신 |
| `/quit` 후 셸 복귀 | 복귀, 즉시 SessionEnd 없음 | 복귀, 즉시 SessionEnd 없음 | 종료 이벤트 수신 | 종료 이벤트 수신 |

Codex는 TUI 연결 해제와 서버의 대화 수명이 다르다. 기존 서버 재연결에서 시작 이벤트가 없을 수 있으며, 이전 PTY 토큰의 이벤트는 거부한다. 따라서 설치 여부나 마지막 이벤트만으로 pane을 실행 중인 Codex로 표시해서는 안 된다. 미수신은 UI에서 별도로 드러낸다. 이 표는 관찰한 버전과 환경의 결과이며 모든 CLI 버전·WSL 배포판의 조합을 검증했다는 뜻이 아니다.

자동 검증:

- native 및 WSL helper 테스트 각 10개: 두 provider의 외부 훅·알 수 없는 필드 보존, 반복 설치·제거, 손상 파일 불변, 부분 설치 복구, 잠금 충돌, 혼합 group, timeout·event 이동 후 소유 command 제거, 전체 훅 비활성 보존, 손상된 Codex 보조 설정에서도 제거, 콘텐츠 비전송.
- 백엔드 수신 테스트: 현재 PTY 수신·토큰 비노출, PTY 교체와 늦은 다른 세션 종료 거부, subagent·만료 이벤트 제외.
- UI 전체 5,203개, 실제 xterm 셀 94개 통과. 환경·provider별 설치 격리 E2E 포함 전체 508개 중 507개 통과, 기존 모바일 지연 포커스 테스트 1개는 단독 3회 재실행 모두 통과(최초 실패를 숨기지 않음).
- Rust workspace 전체, TypeScript 타입 검사, 변경 UI ESLint, workspace clippy `-D warnings`, release 프로파일 check. WSL 정적 companion의 동적 런타임 의존성 검사.
- dev Automation API와 실제 WebView 스크린샷으로 Settings 표시·컨트롤 확인. html2canvas의 입력 글자 기준선 차이는 실제 WebView 캡처와 대조했으며 실제 입력은 잘리지 않는다.

재현 시 기존 dev의 자동 복원 세션이 실행 중일 수 있다. CLI 명령을 보내기 전 반드시 해당 pane이 셸에 돌아왔는지 확인하고, dev 종료는 `bash scripts/kill-dev.sh`만 사용한다.

추가 검증: Windows에서 `/` 경로로 설치한 뒤 `\\` 경로로 조회·재설치하면 다른 command로 인식하던 문제를 회귀 테스트로 재현하고 수정했다. 훅 command 생성 시 Windows 경로 구분자를 통일하며, native helper 테스트 11개가 통과했다.
