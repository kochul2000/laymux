# 0050. Remote GitHub 참조 링크는 서버 terminal CWD로 저장소를 해석한다

- Status: Accepted
- Date: 2026-07-24
- Source: 사용자 리뷰 요구; issue #516; issue #439; PR #517; [architecture/data-flow.md §8.6](../architecture/data-flow.md); [architecture/api-contracts.md §13.4](../architecture/api-contracts.md); [ADR-0015](0015-remote-terminal-state-ownership.md)

## Context

데스크톱 `TerminalView`는 plain text `#123`을 GitHub 이슈/PR 링크로 만드는 provider를
갖고 있다. provider는 pane CWD가 바뀔 때 Rust `resolve_git_remote`로 git `origin`을
해석하고, GitHub 저장소일 때만 `{repoBase}/issues/{number}`를 연다. Codex가 OSC 8로
감싼 참조뿐 아니라 Claude Code가 평문으로 출력한 참조도 같은 UX를 얻는다.

Remote xterm은 별도 정적 HTML/JavaScript surface라 이 provider를 공유하지 않는다.
브라우저는 호스트 filesystem의 `.git/config`를 읽을 수 없고, navigation payload의 CWD를
그대로 서버에 보내 해석하게 하면 인증된 client가 임의 호스트 경로를 탐색하는 계약이
생긴다. 반대로 navigation 응답을 만들 때 모든 terminal의 git config를 동기 조회하면
네트워크 filesystem 하나가 workspace·dock·notification 전체 refresh를 지연시킬 수 있다.

결정 범위는 현재 Remote terminal의 평문 `#number` 탐지, GitHub 저장소 판별, mouse와
touch/pen 활성화다. GitHub 이외 forge 지원, 임의 URL/경로 해석, 저장소 remote 변경 감시,
Remote가 host git 설정을 수정하는 기능은 비목표다.

## Decision

**Remote의 GitHub 저장소 정본은 client가 보낸 경로가 아니라 서버 terminal session의 현재 CWD이며, read-only terminal endpoint가 기존 Rust resolver로 이를 해석한다.**

- `GET /remote/v1/terminals/{id}/github-repo`를 추가한다. 기존 Remote bearer token,
  IP allowlist, Origin gate를 적용하지만 controller lease는 요구하지 않는다. 이 조회와
  외부 public GitHub 페이지 열기는 PTY·workspace·host 파일을 변경하지 않는 observer
  action이고, navigation이 이미 terminal CWD와 branch를 같은 gate 안에서 공개하기
  때문이다.
- 서버는 path query/body를 받지 않는다. route의 terminal ID로 `AppState.terminals`에서
  CWD를 복사한 뒤 lock을 놓고, blocking worker에서 `.git/config`를 읽는다. desktop
  command와 Remote route는 `git_watcher::resolve_github_base_from_working_dir`를 공동
  사용한다. terminal이 없으면 `404`, CWD 또는 GitHub origin이 없으면
  `{cwd:null|"...",repoBase:null}`이며 성공 응답은 `Cache-Control: no-store`다.
- Remote page는 active terminal/CWD가 바뀌는 즉시 기존 `repoBase`를 비우고 진행 중
  요청을 취소한다. 응답은 요청 revision, active terminal ID, navigation CWD, 응답 CWD가
  모두 일치할 때만 적용한다. 응답 URL도 `https://github.com/{owner}/{repo}` 두 path
  segment 형태인지 다시 확인한다. 실패·불일치·비-GitHub 저장소의 결과는 모두 링크가
  없는 상태로 fail closed한다.
- Remote provider는 desktop과 동등한 `(?<!\w)#(\d+)\b` 의미를 사용해 `abc#12`,
  `v1.2#3`, `#fff`를 제외한다. 구형 iOS WebKit 파싱 호환성을 위해 실제 정규식은
  lookbehind 없는 등가식으로 쓴다. xterm cell을 순회해 문자열 offset과 1-based cell
  column을 함께 만들므로 CJK/emoji 선행 문자 뒤 링크 범위도 맞춘다.
- provider는 OSC 8과 `WebLinksAddon` 다음의 추가 provider다. 활성화 직전에도 repository
  revision과 base가 현재 값인지 확인한 뒤 기존 `openRemoteUrl`로
  `{repoBase}/issues/{number}`를 연다. GitHub의 issues↔pull 번호 redirect를 이용해 한
  경로로 이슈와 PR을 모두 처리한다. 기존 touch bridge의 Linkifier hit-test 경로도 이
  provider에 그대로 적용된다.

## Alternatives Considered

- **navigation payload에 모든 terminal의 `repoBase` 포함:** 별도 request가 없지만 매
  navigation refresh마다 모든 CWD의 filesystem을 읽는다. 느린 UNC/WSL/network repo가
  navigation 전체를 막고, 사용하지 않는 terminal까지 조회하므로 기각했다.
- **브라우저가 CWD를 보내는 범용 git resolve endpoint:** active terminal 하나만 조회할
  수 있지만 client가 임의 host path를 제출할 수 있어 권한과 정보 노출 범위를 넓힌다.
  terminal ID로 server-side CWD만 선택하는 계약을 택했다.
- **FileViewer path-link endpoint 재사용:** FileViewer capability와 파일 존재 검증은 git
  저장소 식별과 무관하다. `#123`을 파일 선택으로 위장하면 책임·권한·응답 의미가 모두
  흐려져 기각했다.
- **navigation frontend bridge에서 desktop provider 상태 공유:** desktop `repoBaseRef`는
  React pane-local runtime state이고 Remote의 active surface와 수명이 다르다. backend에
  이미 순수 resolver가 있으므로 별도 UI state bridge를 만들 이유가 없다.
- **active controller lease 필수:** 저장소 identity는 기존 인증된 observer가 받는
  CWD/branch에서 파생되는 read-only 정보이고 링크 열기는 host state를 바꾸지 않는다.
  ownership과 무관한 조회를 lease에 묶으면 reclaim 직후 표시만 불필요하게 달라져
  채택하지 않았다.

## Consequences

- Remote에서도 Claude Code 등의 평문 `#123`이 desktop과 같은 저장소 이슈/PR로 열린다.
  평문 URL, OSC 8, 선택 파일 경로의 기존 우선순위와 동작은 유지된다.
- terminal 선택/navigation refresh마다 active CWD의 작은 filesystem 조회가 하나 생긴다.
  async runtime을 막지 않도록 blocking worker에서 실행하고, browser abort는 결과 적용만
  취소하므로 이미 시작된 filesystem read 자체는 끝날 수 있다.
- endpoint는 인증된 Remote client에 GitHub owner/repo를 추가로 공개한다. 이는 이미
  공개되는 absolute CWD와 branch보다 제한적인 파생 정보이며 no-store로 HTTP cache에
  남기지 않는다.
- Remote JS와 desktop TypeScript에 provider의 cell mapping 코드가 각각 존재한다.
  동등성은 bare token false-positive, wide cell, non-GitHub off-state, stale response,
  mouse/touch activation 테스트로 유지한다. provider 규칙을 바꾸면 두 surface의 테스트를
  함께 갱신해야 한다.
- 재검토 조건은 GitHub 외 forge를 지원하거나, git remote 변경을 CWD 변화 없이 실시간
  추적해야 하거나, Remote navigation이 repository identity를 정식 pane metadata로
  소유하게 되는 경우다.
