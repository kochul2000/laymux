# Laymux Screenshot

Laymux IDE의 dev 인스턴스에서 스크린샷을 캡처하여 확인한다.

## 포트 규칙

- **Dev 인스턴스**: 고정 포트 `19281`
- **Release 인스턴스 (19280)**: 절대 건드리지 않는다
- **인증 불필요**: IP allowlist로 로컬 접근만 허용 (loopback, RFC 1918 사설 대역)

## 절차

### 1. health check

```bash
curl -s http://127.0.0.1:19281/api/v1/health
```

- 응답이 없으면 → 2단계 실행

### 2. 앱 실행 (dev 인스턴스가 없는 경우만)

```bash
cd D:/PycharmProjects/laymux && cargo tauri dev
```

- 반드시 **백그라운드**로 실행한다
- health 엔드포인트가 응답할 때까지 10초 간격으로 폴링한다 (최대 2분)

### 3. 스크린샷 캡처

```bash
curl -s -X POST http://127.0.0.1:19281/api/v1/screenshot
```

- 응답에서 `path` 필드를 확인한다
- 해당 경로의 PNG 파일을 `Read` 도구로 열어서 시각적으로 확인한다

### 4. 결과 보고

스크린샷에서 보이는 내용을 사용자에게 설명한다:
- 레이아웃 구조 (독, 워크스페이스 영역, pane 배치)
- 각 View의 상태
- 눈에 보이는 UI 문제점

## 추가 명령어 (필요시)

| 용도 | 명령 |
|------|------|
| 헬스체크 | `curl -s http://127.0.0.1:19281/api/v1/health` |
| 워크스페이스 목록 | `curl -s http://127.0.0.1:19281/api/v1/workspaces` |
| 터미널 출력 읽기 | `curl -s http://127.0.0.1:19281/api/v1/terminals/{id}/output?lines=50` |
| 터미널에 입력 | `curl -s -X POST http://127.0.0.1:19281/api/v1/terminals/{id}/write -H "Content-Type: application/json" -d '{"data":"ls\n"}'` |
| 그리드 상태 | `curl -s http://127.0.0.1:19281/api/v1/grid` |
| 편집모드 ON | `curl -s -X POST http://127.0.0.1:19281/api/v1/grid/edit-mode -H "Content-Type: application/json" -d '{"enabled":true}'` |
| Pane 분할 | `curl -s -X POST http://127.0.0.1:19281/api/v1/panes/split -H "Content-Type: application/json" -d '{"paneIndex":0,"direction":"vertical"}'` |
| 독 토글 | `curl -s -X POST http://127.0.0.1:19281/api/v1/docks/left/toggle` |
| 독 View 변경 | `curl -s -X PUT http://127.0.0.1:19281/api/v1/docks/left/active-view -H "Content-Type: application/json" -d '{"view":"SettingsView"}'` |
| 워크스페이스 전환 | `curl -s -X POST http://127.0.0.1:19281/api/v1/workspaces/active -H "Content-Type: application/json" -d '{"id":"ws-1"}'` |

## 주의사항

- 스크린샷 파일은 `.screenshots/` 디렉터리에 저장되며 `.gitignore`로 제외됨
- 터미널 내용은 html2canvas 한계로 canvas 렌더링이 깨질 수 있음
- 앱 종료: `bash scripts/kill-dev.sh`
