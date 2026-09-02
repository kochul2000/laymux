# 0226. Composer 별표는 호스트 전역 영구 상태다

- Status: Accepted
- Date: 2026-09-02
- Source: 사용자 요구(Composer 자동완성 항목에 별표 지정, 영구 저장, 모든 워크스페이스 및 Remote에서 사용, Settings에서 목록 조회·추가·삭제) · [ADR-0029](0029-detached-terminal-input-composer.md) · [ADR-0055](0055-composer-history-scope-setting.md) · [data-flow §8.8](../architecture/data-flow.md) · [api-contracts §13.4](../architecture/api-contracts.md)

## Context

Composer history는 셸에 입력한 비밀번호 같은 문자열이 페이지 수명 밖으로 새지 않도록 Desktop과 Remote 모두 runtime 메모리에만 둔다. 이 경계 때문에 유용한 명령도 reload 뒤에는 자동완성에서 사라지며, 사용자가 보존할 항목만 명시적으로 고르는 방법이 없다.

별표는 history 범위 설정과 다른 상태다. 사용자는 한 workspace나 pane에서만 보존하는 것이 아니라 모든 workspace에서 다시 쓰고, Remote에서도 같은 목록을 사용하며, 이후 Settings에서 전체 목록을 확인·정리할 수 있어야 한다. Desktop과 Remote가 각각 저장하면 어느 쪽이 최신인지 정할 수 없고, Remote의 기기별 `localStorage`는 호스트 Settings에서 목록을 보여줄 수 없다. 두 surface가 동시에 쓸 수 있으므로 일반 frontend checkpoint와 독립된 원자적 소유권도 필요하다.

범위는 별표의 저장·조회·토글·자동완성 합성과 Desktop Settings의 목록 조회·추가·삭제다. 가져오기·내보내기와 bulk 편집은 비목표다.

## Decision

**사용자가 명시적으로 별표를 누른 Composer 문자열만 `settings.json`의 호스트 전역 목록에 영구 저장하고, Desktop과 Remote 자동완성은 이 목록을 runtime history보다 먼저 사용한다.**

- SoT는 `terminal.composerStarredEntries: string[]` 하나다. workspace·pane·history scope와 무관한 호스트 전역 ordered set이며, 앞에서 뒤로 오래된 순서다. 빈 문자열과 중복은 저장하지 않는다. 항목은 최대 200개, UTF-8 16 KiB 이하로 제한하고 한도 초과 추가는 기존 항목을 지우지 않고 거절한다.
- runtime history의 비영속 경계는 유지한다. 전송·recall·자동완성만으로 문자열을 저장하지 않으며, 별표 버튼이라는 명시적 사용자 action만 해당 문자열을 영속 목록에 복사한다. 별표 해제는 목록에서만 제거하고 runtime history는 바꾸지 않는다.
- 별표 목록은 backend settings transaction이 소유한다. 전용 IPC `set_composer_starred_entry(text, starred)`와 Remote API `GET /remote/v1/composer/starred`, `POST /remote/v1/composer/starred`만 수정·조회 진입점으로 사용한다. 일반 settings patch에서는 `/terminal/composerStarredEntries`를 read-only로 취급하고 frontend checkpoint는 디스크의 최신 목록을 보존한다.
- 전용 mutation은 atomic load-modify-replace 뒤 최신 전체 목록을 반환하고 `composer-starred-entries-changed` Tauri event를 보낸다. Desktop store는 command 응답과 event로 수렴한다. 따라서 Remote가 변경한 직후에도 Desktop Settings가 같은 목록을 보며, stale frontend checkpoint가 Remote 변경을 덮지 않는다.
- Remote 두 endpoint는 bearer/IP/origin guard뿐 아니라 현재 controller lease를 요구한다. Remote는 lease를 얻은 뒤 호스트 목록을 읽고, 토글 성공 응답으로 자기 메모리를 갱신한다. 별도 `localStorage` 사본은 만들지 않는다.
- 자동완성은 현재 prefix와 일치하는 별표 항목을 최신 별표부터 먼저 내고, 남은 자리를 현재 scope의 runtime history 최신순으로 채운다. 두 출처의 같은 문자열은 한 번만 보이며 기존 최대 표시 개수와 exact-query 제외 규칙은 유지한다.
- Desktop과 Remote는 공용 Lucide `Star` 아이콘 경계로 각 recall/자동완성 행의 별표 상태와 토글을 표시한다. 별표 버튼 조작은 그 행을 draft로 선택하지 않고 textarea focus를 유지한다.
- Desktop Settings의 Terminal 섹션은 전체 목록과 직접 추가·삭제 action을 제공한다. 이 action은 일반 Settings 초안과 분리된 전용 mutation으로 즉시 저장한다.

## Alternatives Considered

- **각 surface의 `localStorage`에 저장** — 구현은 짧지만 Desktop과 Remote 목록이 갈라지고 호스트 Settings에서 하나의 목록으로 관리할 수 없어 기각한다.
- **runtime history 전체를 영속화** — 별도 선택 없이 비밀번호와 토큰까지 저장해 ADR-0029의 보안 경계를 깨므로 기각한다.
- **frontend settings store가 직접 소유** — Remote mutation과 checkpoint가 경쟁하면 마지막 전체 snapshot이 다른 surface의 별표를 잃게 할 수 있어 기각한다.
- **별표 전용 파일** — settings checkpoint 충돌은 피하지만 향후 Settings·내보내기·설정 백업이 두 저장소를 조합해야 하므로 기존 `settings.json`의 backend-owned 필드가 더 단순하다.
- **새 항목 추가 시 가장 오래된 별표 자동 삭제** — 영구 보존을 요청한 항목을 조용히 잃으므로 명시적 한도 오류를 선택한다.

## Consequences

- 별표는 앱 재시작과 workspace 전환 뒤에도 남고, 어느 surface에서 바꿔도 같은 호스트 목록으로 수렴한다.
- 명시적으로 저장한 문자열은 민감정보일 수 있으므로 settings introspection에서는 이 필드를 sensitive로 표시하고 일반 patch에서 숨긴다. 사용자는 Desktop Settings 목록에서 이를 검토·삭제할 수 있다.
- backend-owned 필드가 하나 늘어나므로 frontend checkpoint 보존 테스트, IPC/Remote lease·validation 테스트, Desktop/Remote 별표 interaction 테스트가 필요하다.
- Remote는 claim 뒤 별표 목록 조회 한 번을 추가한다. 조회 실패는 terminal 제어 자체를 끊지 않고 그 문서 수명에서 별표 후보만 사용할 수 없게 한다.
- Settings 목록 UI는 별도 저장 모델이나 migration 없이 이 ordered set과 전용 mutation을 그대로 사용한다.
