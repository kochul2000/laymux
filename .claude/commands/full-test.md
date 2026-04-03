---
description: "전체 테스트 스위트 실행: unit + e2e + build + 실행 검증"
---

# Full Test

단위 테스트, e2e 테스트, 빌드 체크, 실행 검증을 순차적으로 수행한다.
각 단계가 실패하면 즉시 멈추고 원인을 분석하여 수정한 뒤 재시도한다.

## 단계별 실행

### 1단계: 단위 테스트 (Unit Test)

프론트엔드와 백엔드를 **병렬로** 실행한다.

**프론트엔드:**
```bash
cd D:/PycharmProjects/laymux/ui && npx vitest run
```

**백엔드:**
```bash
cd D:/PycharmProjects/laymux && cargo test
```

- 둘 다 성공해야 다음 단계 진행
- 실패 시: 에러 메시지를 분석하고 원인 파일을 읽어 수정 → 재실행

### 2단계: E2E 테스트

```bash
cd D:/PycharmProjects/laymux/ui && npx playwright test
```

- 실패 시: 에러가 발생한 spec 파일과 관련 컴포넌트를 읽어 수정 → 재실행

### 3단계: 빌드 체크

프론트엔드와 백엔드를 **병렬로** 실행한다.

**프론트엔드 (TypeScript 타입 체크):**
```bash
cd D:/PycharmProjects/laymux/ui && npx tsc --noEmit
```

**백엔드 (release 프로파일):**
```bash
cd D:/PycharmProjects/laymux && cargo check --release
```

- 프론트엔드: `tsc --noEmit`으로 타입 에러를 잡는다 (결과물 생성 없음)
- 백엔드: release 프로파일에서만 드러나는 경고/에러를 잡는다
- 둘 다 성공해야 다음 단계 진행
- 실패 시: 컴파일 에러를 수정 → 재실행

### 4단계: 실행 검증 (수정사항 중점)

이번 세션에서 변경된 내용을 중점적으로 검증한다.

#### 4-1. 변경 범위 파악

```bash
cd D:/PycharmProjects/laymux && git diff --name-only HEAD
```

스테이지되지 않은 변경 포함:
```bash
git diff --name-only && git diff --cached --name-only
```

#### 4-2. dev 인스턴스 확인 및 실행

```bash
cat "$APPDATA/laymux-dev/automation.json"
```

- 포트가 확인되면 health 체크: `curl -s http://127.0.0.1:{PORT}/api/v1/health`
- dev 인스턴스가 없으면 **백그라운드로** 실행:

```bash
cd D:/PycharmProjects/laymux && cargo tauri dev
```

health 엔드포인트가 응답할 때까지 10초 간격 폴링 (최대 2분).

#### 4-3. 변경사항 기반 검증

변경된 파일을 분석하여 적절한 Automation API 호출로 검증한다:

| 변경 영역 | 검증 방법 |
|-----------|-----------|
| 워크스페이스 관련 | `GET /api/v1/workspaces`, 생성/전환/삭제 테스트 |
| 그리드/레이아웃 | `GET /api/v1/grid`, 분할/편집모드 테스트 |
| Dock 관련 | `GET /api/v1/docks`, 토글/View 변경 테스트 |
| 터미널 관련 | `GET /api/v1/terminals`, write/output 테스트 |
| UI/스타일 | `/screenshot` 스킬로 스크린샷 캡처 후 시각 확인 |
| 설정 관련 | 설정 변경 후 동작 확인 |
| 기타/전체적 | 스크린샷 + 주요 API 엔드포인트 호출로 전반 확인 |

**반드시** 스크린샷을 1회 이상 캡처하여 UI 상태를 시각적으로 확인한다:
```bash
curl -s -X POST http://127.0.0.1:{PORT}/api/v1/screenshot
```
→ 응답의 `path`를 Read 도구로 열어 확인한다.

변경사항과 관련된 특정 상태를 만들어야 하면 (예: 모달 열기, 특정 View 전환 등) Automation API로 해당 상태를 트리거한 뒤 스크린샷을 캡처한다.

#### 4-4. 문제 발견 시

- 문제를 수정하고 **1단계부터 다시** 실행한다
- 수정-검증 루프는 최대 3회까지 반복한다
- 3회 초과 시 사용자에게 상황을 보고하고 판단을 요청한다

## 최종 보고

모든 단계를 통과하면 결과를 요약한다:

```
## Full Test 결과

| 단계 | 결과 |
|------|------|
| Unit Test (Frontend) | ✓ N개 통과 |
| Unit Test (Backend)  | ✓ N개 통과 |
| E2E Test             | ✓ N개 통과 |
| Build Check (Frontend) | ✓ tsc --noEmit 성공 |
| Build Check (Backend)  | ✓ cargo check --release 성공 |
| 실행 검증            | ✓ 스크린샷 확인 완료 |

변경 파일: N개
수정 루프: N회 (있었다면)
```

## 포트 규칙

- **Dev 인스턴스**: `%APPDATA%\laymux-dev\automation.json`에서 포트를 읽는다 (기본 19281+)
- **Release 인스턴스 (19280)**: 절대 건드리지 않는다
