# 0083. Automation health는 프로세스·빌드 신원을 함께 공개한다

- Status: Accepted
- Date: 2026-07-28
- Source: issue #625 · [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md) · [architecture/api-contracts.md §12](../architecture/api-contracts.md) · [dev-repro-methodology.md §1](../dev-repro-methodology.md)
- Extends: [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)

## Context

ADR-0002의 고정 포트는 release와 dev를 구분하지만 같은 빌드 종류의 여러 워크트리·클론을 구분하지 않는다. 한 dev가 19281을 놓친 뒤 다른 트리의 dev가 그 포트를 소유하면 `/api/v1/health`의 기존 `status`·`version`·`port`는 모두 정상이고, 자동화는 조용히 다른 코드를 측정할 수 있다. 포트 소유 PID를 운영체제에서 찾고 다시 실행 이미지 경로를 조회하면 구분할 수 있지만, 호출자가 이 다단계 절차를 빼먹기 쉽고 크로스플랫폼 도구마다 구현이 달라진다.

Automation API는 `0.0.0.0`에 바인드되고 사설망 IP allowlist 안에서는 무인증이다. 따라서 개발자 사용자명과 체크아웃 디렉터리를 포함할 수 있는 절대 경로를 일반 release 응답에 싣는 것은 대상 확인 편익보다 개인정보 노출 비용이 크다. 반면 dev 실기에서는 정확한 실행 파일과 워크트리를 한 요청으로 대조하는 것이 핵심 요구다.

범위는 health 응답의 인스턴스 신원 계약과 `kill-dev.sh`가 실제로 선택한 대상의 실행 경로 진단이다. 포트 바인딩·재시도·선점 정책, discovery 파일의 권위 승격, 여러 dev의 동시 실행을 위한 동적 포트 설계는 비목표다.

## Decision

**`GET /api/v1/health`는 기존 필드를 유지하면서 `instance`에 프로세스·빌드 신원을 추가하고, 로컬 절대 경로와 브랜치명은 dev에서만 공개한다.**

- `instance.pid`는 응답 프로세스의 런타임 PID이고 `instance.buildKind`는 고정 포트 결정과 같은 `debug_assertions` 기준의 `dev` 또는 `release`다.
- `instance.executablePath`는 런타임 `current_exe`, `instance.worktreeRoot`는 빌드한 체크아웃 루트다. 두 절대 경로는 dev에서만 문자열이며 release에서는 명시적 `null`이다.
- `instance.gitCommit`은 빌드 시점 Git object ID로 dev와 release 모두에 공개한다. `instance.gitBranch`는 빌드 시점 브랜치명이며 dev에서만 공개하고 release에서는 `null`이다. Git 관리 정보가 없는 source archive 빌드는 해당 값을 `null`로 반환하며 health 자체는 실패시키지 않는다.
- 빌드 신원은 `build.rs`가 `.git` 관리 파일을 직접 읽어 컴파일 환경에 주입한다. 런타임 또는 빌드 중 `git` 자식 프로세스를 만들지 않는다. linked worktree의 `gitdir`·`commondir`, detached HEAD, loose ref와 `packed-refs`를 처리한다. normal checkout은 `.git` 디렉터리를 감시하지 않고 `HEAD`·존재하는 worktree별 `logs/HEAD`·현재 loose ref·`packed-refs` 파일만 Cargo 재빌드 입력으로 등록하며, linked worktree는 repoint 가능한 `.git` marker 파일도 감시한다. `logs/HEAD`는 packed branch의 다음 commit이 loose ref를 새로 만드는 전환도 재빌드한다.
- health는 관측 사실만 반환한다. 호출자가 기대 PID·경로·commit과 직접 대조하며, 서버가 특정 호출자의 기대 워크트리를 추측하거나 요청을 거부하지 않는다.
- `kill-dev.sh`의 기존 선택 순서(discovery의 dev 포트 PID, 실패 시 19281 LISTENING 소유자)는 유지한다. 스크립트는 종료 전에 선택 PID의 실행 경로를 Windows CIM 또는 Linux `/proc/<pid>/exe`에서 읽고, 성공·실패 진단에 함께 출력한다. 경로 조회 실패는 `<unavailable>`로 표시하되 기존 종료 판정은 바꾸지 않는다.
- 포트, IP allowlist, 인증 부재, discovery JSON 계약은 ADR-0002를 그대로 따른다.

## Alternatives Considered

- **포트와 version만 계속 신뢰한다.** 같은 버전의 다른 워크트리를 구분하지 못해 #625의 조용한 오측정을 막지 못한다.
- **실행 파일 경로만 반환한다.** 잘못된 target 디렉터리는 찾지만 같은 target 경로에서 재빌드된 commit을 식별하지 못하고, source archive처럼 Git 정보가 없는 경우와 Git checkout을 구분하기 어렵다.
- **모든 빌드에서 절대 경로와 브랜치를 공개한다.** release 사용자의 로컬 디렉터리·사용자명과 개발 브랜치명을 사설망의 무인증 호출자에게 노출하므로 기각했다. commit과 기존 version만 release 코드 신원으로 유지한다.
- **`automation.json`에 신원을 추가하고 권위로 삼는다.** 파일은 stale할 수 있고 API가 실제로 응답하는 프로세스와 원자적으로 결합되지 않는다. 한 요청으로 현재 소유자를 확인한다는 목표에도 맞지 않는다.
- **다른 dev가 19281을 다시 얻지 못하게 포트 선점 정책을 바꾼다.** Tauri dev 재기동과 여러 워크트리의 프로세스 생명주기 정책을 함께 정해야 하는 별도 문제다. 이번 변경은 잘못된 대상을 조용히 사용하는 실패를 관측 가능하게 만드는 데 한정한다.

## Consequences

- 기존 health 소비자는 additive `instance` 객체를 무시할 수 있어 호환된다. 새 자동화는 단일 HTTP 응답의 PID·실행 경로·워크트리·commit을 기대값과 대조할 수 있다.
- dev 응답은 의도적으로 로컬 절대 경로와 브랜치를 노출한다. dev 포트도 ADR-0002의 사설망 allowlist 안에 있으므로 신뢰하지 않는 사설망에서는 dev를 실행하지 않는 운영 전제가 유지된다.
- release는 PID와 공개 가능한 version·commit을 제공하지만 절대 경로와 브랜치는 제공하지 않는다. Git 정보 없이 빌드하면 commit도 `null`이므로 배포 파이프라인이 정확한 commit 증명을 요구할 때는 Git metadata가 있는 checkout에서 빌드해야 한다.
- commit은 빌드한 Git HEAD를 나타낼 뿐 uncommitted diff를 해시하지 않는다. dev 자동화는 `worktreeRoot`와 기대 checkout 상태를 함께 확인해야 한다. dirty tree의 콘텐츠 증명까지 필요해지면 별도 결정으로 다룬다.
- `kill-dev.sh` 출력으로 종료한 대상이 다른 트리였는지 즉시 확인할 수 있지만, 선택 정책 자체는 달라지지 않는다.
- Rust serialization·release redaction·normal/linked worktree의 정밀한 감시 입력과 packed ref에서 loose ref로 전환될 때의 worktree별 `logs/HEAD` 감시, shell의 discovery/fallback 선택·경로 출력 테스트가 계약을 고정한다. shell 회귀는 실제 Windows PowerShell 5.1이 일회성 PID 환경변수를 읽는 계약도 검증한다. Windows dev 실기에서는 `/health` 값과 실제 PID/경로를 대조하고 `kill-dev.sh` 출력이 같은 대상을 가리키는지 확인한다.
