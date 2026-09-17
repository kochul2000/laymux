# WSL Claude 복원 유휴 관측 검증 — 2026-09-17

관련 결정: [ADR-0252](adr/0252-claude-idle-before-app-identification.md).

## 환경과 재현

Windows dev(19281), v1.0.5 기반, WSL Claude Code 2.1.274에서 검증했다. health의 worktreeRoot로 해당 수정 워크트리를 확인했다. release(19280)는 조작하지 않았다. 테스트 전용 WSL 디렉터리와 세션을 만들었다. 짧은 대화는 OK 응답 한 번, 긴 대화는 700줄 도구 출력을 포함한 312,742바이트 transcript다.

수정 전 자동 복원과 셸 `claude --resume` 각각에서 짧은·긴 대화를 복원한 4조합 모두 `task` 미확정으로 pane clear가 `busy`를 반환했다. Claude 내부 `/resume`의 2조합은 정상이었다. 타이틀 `✳ <대화 제목>`의 live 이벤트는 앱 이름이 없는 상태로 먼저 도착했고, 이후 프로세스 reconcile이 Claude를 식별했다. 첫 유휴를 버린 탓에 추가 입력 없이 작업 상태가 복구되지 않았다.

## 반복 절차와 결과

각 조합마다 테스트 pane을 새 WSL TerminalView로 만들고 다음을 반복했다.

1. `lastClaudeSession` 자동 복원, 셸 `claude --resume <id>`, Claude 내부 `/resume <id>` 중 하나로 짧은·긴 세션을 복원한다.
2. PTY 준비와 Claude 식별을 기다린 뒤 입력 없이 task/selector 상태를 읽는다.
3. Alt+L과 같은 경로인 `POST /api/v1/panes/{paneId}/clear`를 실행한다.
4. 즉시·2초·7초 상태를 읽고, 그 사이에는 입력하지 않는다.
5. clear를 다시 실행하고 `cleared` 포함, `skipped`/`failed` 없음과 화면 버퍼를 확인한다.

| 최종 코드 화면 | 자동 복원 | 셸 --resume | 내부 /resume | clear 성공 |
| --- | --- | --- | --- | --- |
| 372열 × 69행 | 짧음·긺 통과 | 짧음·긺 통과 | 짧음·긺 통과 | 12/12 |
| 분할 184열 × 69행 | 짧음·긺 통과 | 짧음·긺 통과 | 짧음·긺 통과 | 12/12 |

모든 샘플의 관측은 confirmed였고 아이콘은 정상 유휴/결과 없는 종료 표시인 `—`였다. 앱 식별에 약 40초가 걸린 셸 복원도 통과했다. 앞선 수정 버전에서도 넓은 화면 6조합을 두 번씩, 총 12회 통과했으며, 이후 독립 리뷰에서 발견한 attach 순서 경계를 보완한 최종 코드로 위 12회를 다시 검증했다. 개발 중 코드 변경으로 중단한 실행은 통과 횟수에서 제외했다.

## laymux 재시작 자동 복원

사용자가 확인한 실제 재현 경로는 laymux 재시작 시 자동 복원이다. dev를 `bash scripts/kill-dev.sh`로 종료하고 같은 워크트리에서 다시 실행해 두 번 검증했다. 두 실행 모두 Claude가 자동으로 열렸으며 사용자 입력 없이 최초 관측과 7초 뒤 관측이 `idle/confirmed`를 유지했다. health의 gitCommit은 최종 수정 커밋 `65c1baf0`이었다.

최초 준비에서는 테스트 pane의 복원 ID가 저장되지 않아 셸이 열렸으므로 실패한 준비 실행으로 제외했다. 첫 유효 실행은 dev 종료 후 테스트 pane의 저장 설정에만 짧은 대화의 `lastClaudeSession`을 명시한 fixture를 사용했다. 이후 해당 ID가 설정에 유지됨을 확인했고, 두 번째는 설정 재주입 없이 dev를 재시작해 자동 복원을 확인했다. 앱 시작 중의 API 시간 제한은 준비 후 재시도로 구분했다. 이 결과를 Claude 세션 ID 수집·영속 경로 전체의 검증으로 해석하지 않는다.

두 번째 자동 복원 후 `/clear`를 직접 제출하고 이후에는 입력하지 않았다. 즉시·2초·10초·30초 관측 모두 `Claude`, `idle/confirmed`, `outputActive=false`, `—`를 유지했다.

## 자동 회귀 검사

- 최초 타이틀 → 늦은 앱 식별, attach 대기 → reconcile → attach, 이전 명령 → 유휴 → attach → 식별 순서를 검사한다.
- 새 타이틀·명령·제출 입력·generation/appSession 변경·다른 앱·pane 삭제·준비 해제는 보류를 폐기한다.
- 캐시 타이틀을 관측으로 승격하지 않고, 기존 승인 모달을 유휴로 덮지 않으며, 최초 유휴가 완료 알림을 만들지 않는지 검사한다.
- 관련 unit 128개 통과. 최종 전체 UI unit은 Windows에서 `npx vitest run --maxWorkers=4`로 238파일, 4,981개 모두 통과했다. UI production build와 변경 파일 ESLint·Prettier도 통과했다.

물리 Alt+L 키 주입은 수행하지 않았다. 이 검증은 실제 dev PTY/Claude와 공통 pane clear 실행 경로를 대상으로 하며 OS 키 전달 자체를 검증한 것은 아니다.

최종 재시작 이후 전체 화면 screenshot API는 두 차례 frontend 응답 시간 제한에 걸려 최종 이미지 검증 근거로 사용하지 않았다. 위 상태 판정은 dev terminal API의 구조화 관측으로 확인했다.
