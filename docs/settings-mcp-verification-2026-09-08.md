# 설정 MCP 개선 검증 — 2026-09-08

ADR: [0242 — 범위별 설명과 Remote 기기 적용 확인](adr/0242-settings-mcp-scoped-discovery-and-remote-device-bridge.md).

최신 main 통합 시 표시 설정 3개(기본행·확장행 버튼 배율, 선택 핸들 크기)를 추가해 최종 노출은 44개다. 아래 실제 CLI 기록은 통합 전 41개 계약에 대한 결과이며, 추가 키는 별도 회귀 테스트로 검증한다.

## 실행 맥락·누락 설정 확장 검증

사용자 추가 요구에 따라 실제 CLI 시나리오를 기존 3개(에이전트별 1개)에서 **9개(에이전트별 PC·Remote·혼합 3개)**로 확장했다. PC와 Remote 시나리오는 사용자 문장에서 대상 기기를 지정하지 않고 MCP의 현재 제어 표면으로 판단하게 했다. 혼합 시나리오는 명시적인 PC 설정, 현재 Remote 화면, PC의 Remote 연결 정책을 한 요청에 넣었다.

PC 시나리오는 기존 글꼴·테마·절전·붙여넣기·단축키에 실제 위젯 옵션 카탈로그를 사용하는 Codex 사용량 위젯 추가를 포함한다. Remote 시나리오는 41개 노출 키 중 글꼴·스크롤·입력 모드·기록·숨김 줄 수·불투명도·패널·snapshot 예산·플로팅 패드/버튼·사용자 특수키·입력바 순서·탐색 제외를 묶어 변경한다. 혼합 시나리오는 기기의 위젯바 선호를 보존하면서 호스트의 위젯 공개 정책만 끄고, heartbeat 유예·첨부 상한·플로팅 전체 표시도 변경한다.

| CLI | PC 기본 맥락 | Remote 기본 맥락 | 명시적 PC + 현재 Remote + 연결 정책 |
| --- | --- | --- | --- |
| Claude | 통과 | 통과 | 통과 |
| Codex | 통과 | 통과 | 통과 |
| Grok | 통과 | 통과 | 통과 |

독립 검증기는 최종 MCP 값·기기 localStorage·CSS·플로팅 DOM을 비교하고 PC/기기 사이의 불필요한 변경 및 기존 단축키·위젯·배치 손실을 검사한다. 에이전트 로그에서는 실제 도구 호출만 추출하여 첫 저장 전에 `get_settings_context`를 조회·재확인했는지 검사한다. 각 시나리오 후 원래 설정을 복원한다. 스크린샷도 저장하며 플로팅 표시/숨김 화면을 직접 확인했다.

9개 모두 첫 저장 전에 실제 맥락 도구를 두 번 호출했다. 최종 통합 결과는 `.tmp/settings-mcp-agent-check/report-expanded.json`, 개별 로그는 `{provider}-{pc|remote|mixed}.jsonl`, 기기 스크린샷은 `{provider}-{scenario}-remote.png`다. 세 CLI의 모든 확장 시나리오가 독립 검사와 복원을 통과했다.

[설정 MCP 전수 대조](settings-mcp-coverage-2026-09-08.md)에 PC 34개 섹션·305개 경로 패턴, Remote 저장 키 17개와 제외 이유를 모두 기록했다. 경로 수는 읽기 전용 구조와 배열/자유 JSON 경계를 포함하며 모두 쓰기 가능한 필드의 수가 아니다.

## 최초 실제 에이전트 검증

Windows의 임시 APPDATA·WebView 저장소를 사용하는 dev(19281)에서 수행했다. release(19280)는 조작하지 않았다. Claude Code 2.1.263, Codex CLI 0.153.4, Grok 1.0.13의 설치된 기본 모델을 사용했다. 설정 키나 소스코드를 프롬프트에 제공하지 않고 `laymux-dev` MCP 설명·조회·검증·변경 도구만으로 해결하도록 요청했다.

공통 요청은 PC 터미널 18px, 비터미널 본문 16px, GitHub Light 테마, 작업 중일 때만 절전 방지, 선택 자동 복사 끄기, 여러 경로 붙여넣기 줄바꿈·따옴표, 새 워크스페이스 단축키 변경이었다. 연결된 폰 화면에는 터미널 20px·입력창 18px·메뉴 16px·한 손가락 스크롤 현재의 두 배·자동완성 끄기를 요청했다. PC 메뉴 크기처럼 지원하지 않는 요청은 대체 설정을 쓰지 않고 설명하도록 했다.

| CLI | MCP 검증·저장·재조회 | 독립 검증기 결과 |
| --- | --- | --- |
| Claude | 통과 | PC·Remote 값, 기기 localStorage, CSS, 스크린샷 확인 후 원래 설정 복원 |
| Codex | 통과 | 같은 조건 통과·복원 |
| Grok | 통과 | 같은 조건 통과·복원 |

세 에이전트 모두 PC 메뉴 크기는 고정이라는 설명을 읽고 대체 변경을 하지 않았다. PC와 기기 설정의 차이 및 프로필·pane override 우선순위도 보고했다. 단축키는 실제 frontend 레지스트리의 command를 읽고 기존 목록을 보존했다.

개선 전에는 전체 조회가 `{}`였고, 폰트 하나의 설명도 약 90KB였다. Claude는 설명이 도구 출력 상한에 걸려 키를 추측했고, Grok은 폰 설정을 PC `/remote` 아래에서 찾다 실패했다. 개선 후 같은 폰트 설명은 4,386 bytes이며 필요한 스키마·범위·의미·적용 시점을 포함한다. Codex 초기 실행의 도구 승인은 검증용 실행 인자의 개별 설정 도구 허용으로 해결했다. 사용자 전역 MCP 설정을 바꾸지 않았다.

## 재현

임시 `APPDATA`와 `WEBVIEW2_USER_DATA_FOLDER`, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9230`을 지정한 dev를 실행한다. 사용자 설정과 분리된 인스턴스인지 먼저 확인한다. UI dev 서버는 `localhost:1420`이어야 한다.

Windows의 `ui/`에서 다음을 실행한다. CLI 계정 사용량이 발생하며, 각 CLI는 순차로 설정을 변경하고 독립 검증기가 되돌린다.

```powershell
$env:LAYMUX_REPRO_ISOLATED = '1'
node scripts/check-settings-mcp-agents.mjs
# 특정 CLI만: node scripts/check-settings-mcp-agents.mjs grok
```

검증기는 health의 dev/port/worktree를 확인하고 설정 도구만 허용한다. 로그·기기 스크린샷·결과 JSON은 `.tmp/settings-mcp-agent-check/`에 저장한다. 인증 token은 로그에 출력하지 않는다. 종료는 동일 APPDATA에서 `bash scripts/kill-dev.sh`를 사용한다.

## 범위와 제약

- PC는 34개 설정 섹션을 탐색하고 기존 엄격 검증·revision·마스킹·snapshot 저장 경로로 변경한다. 구조적 세션 상태와 이미 읽기 전용인 필드는 일반 patch로 바꾸지 않는다.
- Remote는 현재 controller 기기의 표시·스크롤·입력·플로팅·배치·탐색 제외 44개 최상위 설정 키를 지원한다. 기기별 소유권을 유지하며 미연결·구버전 페이지·15초 이상 오래된 snapshot은 오류다. 적용 확인은 최대 20초다.
- 입력 초안·과거 입력 내용·인증정보는 기기 설정 도구에 노출하지 않는다. 사용자 등록 특수키의 설정된 전송 문자열은 지원하지만 저장만으로 실행하지 않는다. 임의 localStorage 편집이나 오프라인 기기 큐는 제공하지 않는다.
- 실행 맥락은 현재 human-control owner 기준이며 개별 외부 채팅 출처의 증명은 아니다. 명시적 사용자 대상이 우선하고, 출처가 현재 제어 표면과 다르면 확인해야 한다.
- Android lifecycle/lease E2E는 bundled Remote 코드와 native bridge 모형을 사용했다. 실제 Android 하드웨어에서 세 CLI를 별도로 실행한 검증은 아니다. 실제 Remote 변경은 Chromium의 휴대폰 크기 브라우저에서 확인했다.

## 자동 검사

- UI 전체 unit: 233 파일, 4,891 테스트 통과.
- Remote 표시·heartbeat 저장/실패·플로팅 E2E: 17개 통과. Android lifecycle·lease 복구/전환 18개도 통과했다.
- 최초 작업에서 reconnect까지 확장한 36개 중 34개 통과. 실패 2개는 기존 Remote UI의 스피너 스타일 변경과 기존 reconnect assertion 불일치다. 이번 확장에서는 위 35개 E2E를 실행했다.
- Rust 전체 lib: 2,054개 중 2,049개 통과. 실패 5개는 기존 Remote UI 변경과 `remote_server::page`의 소스 문자열 assertion 불일치다(bootstrap, soft-key toolbar, pane/workspace exclusion icon, composer send icon). 이 다섯 검사와 그 기대 문자열은 이번 설정 개선에서 변경하지 않았다.
- 설정 전용 Rust 계약: 62개 통과. Remote 기기 bridge·실행 맥락·중첩 schema 5개와 release/dev 도구 등록 검사도 통과했다.
- 변경분 ESLint, TypeScript `tsc --noEmit`, Rust `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check --release`, dev 빌드가 통과했다. 전체 조회·필터 응답 크기·민감 배열 마스킹·기기 대상·만료·불일치 응답·저장 실패 회귀 검사가 포함된다.

## PR 최신 main 통합 검증

기준 main은 `3fa04b34`, PR은 #1038이다. 다른 세션의 미커밋 변경은 포함하지 않고 별도 워크트리에서 통합했다. 최신 main의 버튼 배율 2종·선택 핸들 크기와 사용자 키 `submit`을 반영했다. 표시 기본값 전수 대조, 배율 enum 거부, 기존 사용자 키 heartbeat 수신·변경 테스트를 추가했다.

- 최신 Remote 설정·플로팅·Android lifecycle·lease 전환/복구 E2E: 41개 통과.
- 관련 UI·실제 production bundle 검사: 177개 통과. 추가 배율 거부 테스트 2개 포함 스키마 테스트도 통과.
- Rust settings 통합: 62개 통과. Remote relay·MCP 테스트, TypeScript, 변경 파일 ESLint, 전체 clippy와 UI 빌드 통과.
- 전체 UI 최초 실행: 4891개 통과, 3개 실패. 번들 해시는 최종 stamp 재생성 후 통과했고 production bundle의 동시 빌드 5초 타임아웃은 단독 재실행에서 통과했다. 남은 updater-release-contract는 main의 Windows 전용 workflow에 이미 없는 `max-parallel: 1`과 Linux target을 요구하는 기존 검사다.
- 전체 Rust 최초 실행: 2056개 통과, 9개 실패. identity 1개는 테스트 컴파일 중 commit으로 HEAD가 바뀐 영향이며 고정 HEAD 재실행 3개 통과로 확인했다. 나머지 page.rs 8개는 main에도 없는 예전 아이콘·함수 서명·path-link 소스 문자열을 요구한다. `git show origin/main`의 page.html/remote-app.js에서 해당 문자열이 모두 없는 것을 대조했다. 이번 변경의 필수 관련 검증과 분리해 기록하며 전체 스위트 통과로 표현하지 않는다.

독립 unless-p1 리뷰 1회: P1 없음, P2 사용자 키 submit 누락 1건 수정, 현재 지원 수 문서 Nit 수정. 추가 ADR급 후속 작업 없음.
