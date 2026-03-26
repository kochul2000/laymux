# Laymux Screenshot

Laymux IDE **dev 인스턴스**를 실행하고 스크린샷을 캡처하여 확인한다.
개발 중에는 반드시 dev 빌드(포트 19281+)를 사용한다. Release 인스턴스(포트 19280)는 건드리지 않는다.

## 절차

### 1. dev 앱 포트 확인

dev discovery 파일에서 포트를 읽는다:

```bash
cat "$APPDATA/laymux-dev/automation.json" 2>/dev/null || echo "NOT_RUNNING"
```

- `port` 값이 있으면 → 해당 포트로 health 체크 후 3단계로 이동
- 파일이 없으면 → 2단계 실행

### 2. dev 앱 실행 (실행 중이 아닌 경우만)

```bash
cd D:/PycharmProjects/laymux && cargo tauri dev
```

- 반드시 **백그라운드**로 실행한다
- dev discovery 파일(`%APPDATA%/laymux-dev/automation.json`)이 생성될 때까지 10초 간격으로 폴링한다 (최대 2분)
- 파일이 생성되면 `port` 값을 읽어서 사용

### 3. 스크린샷 캡처

```bash
# PORT는 discovery 파일에서 읽은 값 (기본 19281)
curl -s -X POST http://127.0.0.1:$PORT/api/v1/screenshot
```

- 응답에서 `path` 필드를 확인한다
- 해당 경로의 PNG 파일을 `Read` 도구로 열어서 시각적으로 확인한다

### 4. 결과 보고

스크린샷에서 보이는 내용을 사용자에게 설명한다:
- 레이아웃 구조 (독, 워크스페이스 영역, pane 배치)
- 각 View의 상태
- 눈에 보이는 UI 문제점

## 추가 명령어 (필요시)

> 모든 명령에서 `$PORT`는 dev discovery 파일에서 읽은 포트 값이다.

| 용도 | 명령 |
|------|------|
| 워크스페이스 목록 | `curl -s http://127.0.0.1:$PORT/api/v1/workspaces` |
| 터미널 출력 읽기 | `curl -s http://127.0.0.1:$PORT/api/v1/terminals/{id}/output?lines=50` |
| 터미널에 입력 | `curl -s -X POST http://127.0.0.1:$PORT/api/v1/terminals/{id}/write -H "Content-Type: application/json" -d '{"data":"ls\n"}'` |
| 그리드 상태 | `curl -s http://127.0.0.1:$PORT/api/v1/grid` |
| 편집모드 ON | `curl -s -X POST http://127.0.0.1:$PORT/api/v1/grid/edit-mode -H "Content-Type: application/json" -d '{"enabled":true}'` |
| Pane 분할 | `curl -s -X POST http://127.0.0.1:$PORT/api/v1/panes/split -H "Content-Type: application/json" -d '{"paneIndex":0,"direction":"vertical"}'` |
| 독 토글 | `curl -s -X POST http://127.0.0.1:$PORT/api/v1/docks/left/toggle` |
| 독 View 변경 | `curl -s -X PUT http://127.0.0.1:$PORT/api/v1/docks/left/active-view -H "Content-Type: application/json" -d '{"view":"SettingsView"}'` |
| 워크스페이스 전환 | `curl -s -X POST http://127.0.0.1:$PORT/api/v1/workspaces/active -H "Content-Type: application/json" -d '{"id":"ws-1"}'` |

## 주의사항

- **개발 중에는 항상 dev 인스턴스(19281+)를 사용한다. Release(19280)는 건드리지 않는다.**
- 스크린샷 파일은 `.screenshots/` 디렉터리에 저장되며 `.gitignore`로 제외됨
- 터미널 내용은 html2canvas 한계로 canvas 렌더링이 깨질 수 있음
- dev 앱 종료: `taskkill //F //IM laymux.exe` (Windows) — release도 같이 죽을 수 있으니 주의
