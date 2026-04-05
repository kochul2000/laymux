# Laymux Screenshot

Laymux IDE의 dev 인스턴스에서 스크린샷을 캡처하여 확인한다.

## 포트 및 인증 규칙

- **Dev 인스턴스**: `%APPDATA%\laymux-dev\automation.json`에서 `port`와 `key`를 읽는다
- **Release 인스턴스 (19280)**: 절대 건드리지 않는다
- **모든 API 호출**에 `Authorization: Bearer {KEY}` 헤더를 포함해야 한다 (health 제외)

## 절차

### 1. dev discovery 파일 읽기

```bash
cat "$APPDATA/laymux-dev/automation.json"
```

- `port` 필드 값을 이후 모든 요청의 `{PORT}`로 사용한다
- `key` 필드 값을 이후 모든 요청의 `{KEY}`로 사용한다
- 파일이 없으면 → 2단계 실행

### 2. 앱 실행 (dev 인스턴스가 없는 경우만)

```bash
cd D:/PycharmProjects/laymux && cargo tauri dev
```

- 반드시 **백그라운드**로 실행한다
- health 엔드포인트가 응답할 때까지 10초 간격으로 폴링한다 (최대 2분)
- 실행 후 1단계를 다시 수행하여 `port`와 `key`를 읽는다

### 3. 스크린샷 캡처

```bash
curl -s -X POST http://127.0.0.1:{PORT}/api/v1/screenshot -H "Authorization: Bearer {KEY}"
```

- `{PORT}`와 `{KEY}`는 1단계에서 읽은 값으로 대체한다
- 응답에서 `path` 필드를 확인한다
- 해당 경로의 PNG 파일을 `Read` 도구로 열어서 시각적으로 확인한다

### 4. 결과 보고

스크린샷에서 보이는 내용을 사용자에게 설명한다:
- 레이아웃 구조 (독, 워크스페이스 영역, pane 배치)
- 각 View의 상태
- 눈에 보이는 UI 문제점

## 추가 명령어 (필요시)

모든 URL에서 `{PORT}`는 dev 인스턴스 포트로, `{KEY}`는 API 키로 대체한다.
인증 헤더: `-H "Authorization: Bearer {KEY}"`

| 용도 | 명령 |
|------|------|
| 헬스체크 (인증 불필요) | `curl -s http://127.0.0.1:{PORT}/api/v1/health` |
| 워크스페이스 목록 | `curl -s http://127.0.0.1:{PORT}/api/v1/workspaces -H "Authorization: Bearer {KEY}"` |
| 터미널 출력 읽기 | `curl -s http://127.0.0.1:{PORT}/api/v1/terminals/{id}/output?lines=50 -H "Authorization: Bearer {KEY}"` |
| 터미널에 입력 | `curl -s -X POST http://127.0.0.1:{PORT}/api/v1/terminals/{id}/write -H "Authorization: Bearer {KEY}" -H "Content-Type: application/json" -d '{"data":"ls\n"}'` |
| 그리드 상태 | `curl -s http://127.0.0.1:{PORT}/api/v1/grid -H "Authorization: Bearer {KEY}"` |
| 편집모드 ON | `curl -s -X POST http://127.0.0.1:{PORT}/api/v1/grid/edit-mode -H "Authorization: Bearer {KEY}" -H "Content-Type: application/json" -d '{"enabled":true}'` |
| Pane 분할 | `curl -s -X POST http://127.0.0.1:{PORT}/api/v1/panes/split -H "Authorization: Bearer {KEY}" -H "Content-Type: application/json" -d '{"paneIndex":0,"direction":"vertical"}'` |
| 독 토글 | `curl -s -X POST http://127.0.0.1:{PORT}/api/v1/docks/left/toggle -H "Authorization: Bearer {KEY}"` |
| 독 View 변경 | `curl -s -X PUT http://127.0.0.1:{PORT}/api/v1/docks/left/active-view -H "Authorization: Bearer {KEY}" -H "Content-Type: application/json" -d '{"view":"SettingsView"}'` |
| 워크스페이스 전환 | `curl -s -X POST http://127.0.0.1:{PORT}/api/v1/workspaces/active -H "Authorization: Bearer {KEY}" -H "Content-Type: application/json" -d '{"id":"ws-1"}'` |

## 주의사항

- 스크린샷 파일은 `.screenshots/` 디렉터리에 저장되며 `.gitignore`로 제외됨
- 터미널 내용은 html2canvas 한계로 canvas 렌더링이 깨질 수 있음
- 앱 종료: `taskkill //F //IM laymux.exe` (Windows)
