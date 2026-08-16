# 0165. 데스크톱 path-link는 pointer release에서만 검증한다

- Status: Accepted
- Date: 2026-08-16
- Source: 사용자 요구("선택 드래그 중에는 path를 파싱하지 말고 마지막에 한 번"), `docs/architecture/data-flow.md` §8.6, ADR-0148
- Supersedes: [ADR-0148](0148-bounded-multi-path-selection-links.md)

## Context

ADR-0148은 데스크톱 터미널 선택이 변할 때마다 오래된 링크를 지우고 120ms trailing debounce 뒤 경로 후보를 파싱·검증하도록 정했다. 연속된 선택 이벤트는 한 타이머로 합쳐지지만, 사용자가 천천히 드래그하거나 이동 사이에 120ms 이상 머물면 드래그가 끝나기 전에도 후보 파싱과 `stat_paths` IPC가 반복된다. 이미 시작한 filesystem stat은 다음 선택 변경이 결과를 무효화해도 취소할 수 없다. 특히 WSL·UNC 경로 검증이 포함되면 선택 조작 자체의 응답성이 저하될 수 있다.

경로 링크는 사용자가 확정한 선택을 대상으로 하는 보조 기능이다. 드래그 중 중간 선택에 링크를 미리 표시하는 것보다 포인터 조작의 응답성과 filesystem 조회 횟수의 결정성이 우선한다. ADR-0148의 bounded maximal-munch 후보, 길이·줄·개수 상한, 절대경로 중복 제거, 단일 batch stat, decoration 및 Remote 계약은 그대로 유지해야 한다.

## Decision

데스크톱 터미널의 path-link 후보 파싱과 filesystem stat은 terminal 안에서 시작한 pointer 선택 gesture의 release가 xterm의 `mouseup` 선택 확정까지 끝난 뒤 현재 최종 선택을 대상으로 정확히 한 번만 수행한다.

새 `pointerdown`은 진행 중인 이전 검증 revision을 즉시 무효화하되, 기존 decoration은 이어지는 `mousedown`에서 path-link 클릭 대상 캡처가 끝날 때까지 유지한다. 이동량이 click slop을 넘는 첫 `pointermove`가 새 선택 drag를 확정하면 기존 decoration을 지운다. xterm은 document-level `mouseup`에서 선택을 확정한 뒤 `onSelectionChange`를 발행하므로, window `mouseup`이 그 다음에 최종 `getSelection()`과 `getSelectionPosition()`을 읽는다. 브라우저 밖 release처럼 호환 `mouseup`이 오지 않는 경우에는 `pointerup`이 예약한 다음 task가 같은 최종화를 수행한다. `pointercancel`은 gesture와 fallback을 폐기하고 검증하지 않는다.

`onSelectionChange`는 새 선택이 생겼음을 gesture에 표시하고 기존 decoration과 이전 검증 revision을 무효화하는 일만 담당한다. 이 경로와 pointermove에서는 debounce timer를 만들거나 `extractPathCandidatesFromSelection`, `joinCwdPath`, `stat_paths`를 호출하지 않는다. gesture 최종화만 ADR-0148의 bounded 후보 추출·deduplicate·batch stat 규칙을 한 번 실행한다. 선택이 비었거나 상한을 벗어나거나 후보가 없으면 filesystem IPC 없이 끝낸다.

Remote xterm의 선택 이벤트와 host bridge 왕복 정책은 별도 surface 계약이므로 이번 결정에서 바꾸지 않는다. `copyOnSelect`도 path-link와 독립된 기존 동작을 유지한다.

## Alternatives Considered

기존 120ms trailing debounce를 유지하는 방식은 빠른 연속 드래그를 합치지만 느린 드래그와 잠깐의 정지마다 중간 선택을 검증하므로 관측된 지연을 제거하지 못한다.

debounce 시간을 더 늘리는 방식은 반복 가능성을 낮추지만 입력 속도에 따라 동작이 달라지고, 충분히 긴 드래그에서는 여전히 중간 filesystem stat을 실행한다.

진행 중인 `stat_paths`를 취소하는 방식은 stale 결과 비용 일부를 줄일 수 있지만 후보 파싱과 IPC 시작 비용은 이미 발생하며 Rust command 취소 계약을 새로 만들어야 한다. 최종 선택 한 번만 조회하면 취소 프로토콜 자체가 필요 없다.

## Consequences

드래그 길이와 속도에 관계없이 한 pointer gesture가 만드는 path 후보 파싱과 filesystem stat은 최대 한 batch다. pointerdown에서 이전 비동기 결과를 무효화하고 첫 실제 drag 이동에서 기존 decoration을 한 번 정리하므로 경로 검증이 포인터 조작과 경쟁하지 않는다.

경로 밑줄은 드래그를 놓은 뒤에만 나타난다. 키보드나 프로그램으로만 선택을 바꾸고 pointer release가 전혀 없으면 path-link를 새로 검증하지 않는다. 이 기능의 입력 계약은 명시적인 pointer 선택이며, 이후 keyboard selection 지원이 필요하면 완료 신호와 비용 상한을 별도로 결정한다.

이전 gesture에서 이미 시작된 비동기 stat은 강제 취소하지 않지만, 새 pointerdown이나 선택 변경으로 revision이 바뀌면 결과를 표시하지 않는다. 회귀 테스트는 기존 debounce 시간보다 긴 drag 동안 stat이 0회인지, 실제 브라우저의 `pointerup` → xterm `mouseup`/`onSelectionChange` → window `mouseup` 순서 뒤 정확히 1회인지, 새 drag 이동과 `pointercancel`이 stale 상태와 fallback을 폐기하는지 고정한다. Remote의 trailing debounce와 최종 pointer-up 검증은 유지된다.
