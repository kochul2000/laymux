# 0067. 번들 ConPTY의 출력·배치 계약을 하나로 고정한다

- Status: Proposed
- Date: 2026-07-27
- Source: PR #581 후속 리뷰; issue #580; 번들 ConPTY `1.23.251008001` resize raw-output 실측; [ADR-0026](0026-conpty-width-resize-repaint-filter.md); [ADR-0066](0066-bundled-conpty-runtime.md)
- Relation: ADR-0066을 대체한다(벤더링·OSC/DSR/DA1 응답 소유권 결정은 아래에서 명시적으로 바꾸지 않은 범위에 한해 유지). ADR-0026은 **대체하지 않는다** — 그중 resize repaint filter 조항 하나만 이 ADR이 가져간다. ADR-0026의 공통 fit 스케줄러, 1 MiB 청크 write FIFO, Windows quiet window, remote 복귀 backend resize 동기화·재시도, `@xterm/xterm` 6.0.0 고정과 `isWrapped` 패치는 계속 ADR-0026이 정본이며 Accepted다.

## Context

PR #581은 Windows 자식을 in-box conhost가 아니라 Microsoft ConPTY 재배포본으로
띄워 `OSC 10/11` 색상 질의가 xterm.js까지 도달하게 했다. 그러나 런타임 교체는
두 기존 전제를 동시에 깨뜨렸다.

첫째, ADR-0026의 resize repaint filter는 in-box conhost가 폭 변경 뒤 내보내던
`ESC[?25l … ESC[H … ESC[?25h` 화면 복제 프레임을 500ms 동안 찾아 제거한다.
번들 `1.23.251008001`은 normal buffer에 scrollback이 있어도 그 host repaint를
내보내지 않는다. 그런데 UI는 Windows라는 이유만으로 필터를 계속 무장했다. 같은
시간 창 안에 SIGWINCH를 받은 TUI가 동일한 hide→home→show 모양으로 정상 redraw를
보내면 필터가 출처를 구분할 수 없어 정상 프레임 전체를 삭제한다.

둘째, build script는 벤더 파일을 `target/<profile>/`과 `gen/conpty/`에 복사한 뒤
`tauri_build::build()`를 호출했다. Tauri는 bundle resource를 dev 실행 파일 옆에도
다시 복사하므로 실행 중인 dev 인스턴스가 `conpty.dll`을 로드한 상태에서는 두 번째
복사가 `ERROR_SHARING_VIOLATION`으로 실패했다. 첫 번째 복사 실패 처리도 오류 종류와
무관하게 파일 크기만 같으면 기존 파일을 승인해, 같은 길이의 stale PE가 설치본에
들어갈 수 있었다.

마지막으로 ADR-0066은 미지원 아키텍처와 벤더 누락 시 경고 후 in-box conhost로
폴백한다고 했지만 구현은 빌드를 중단했다. 색상 질의 계약이 머신이나 타깃에 따라
조용히 사라지는 것을 허용할지, 지원 범위를 명시하고 빌드를 실패시킬지 하나를
선택해야 한다.

범위는 번들 ConPTY의 build-time 배치 소유권, 실패 정책, 그리고 그 런타임의 resize
출력 계약에 따른 WebView 필터의 존치 여부다. 벤더 버전 자체의 변경, Rust OSC 단일
패스, xterm.js가 만드는 프로토콜 응답의 라우팅, ADR-0026의 나머지 결정(공통 fit
스케줄러, write FIFO, quiet window, xterm reflow patch)은 비목표다.

## Decision

**지원되는 Windows 빌드는 번들 ConPTY를 필수 계약으로 삼고 정확한 파일을 한 번만
배치하며, live PTY 출력은 어떤 resize repaint filter도 거치지 않고 xterm에 도달한다.**

- 지원 Windows 아키텍처는 `x86_64`와 `aarch64`다. 표에 없는 아키텍처이거나 대응하는
  `conpty.dll`/`OpenConsole.exe`가 없으면 build script가 실패한다. 제품 빌드에서
  조용한 in-box conhost 폴백은 허용하지 않는다.
- `src-tauri/src/conpty_runtime.rs`의 버전·파일·아키텍처 표와 벤더 트리가 배치의
  정본이다. build script는 이 표와 배치 helper 변경을 `rerun-if-changed`로 추적한다.
- build script가 dev 실행 파일 디렉터리와 `gen/conpty/` 스테이징을 소유한다. 복사
  전후에 벤더 원본과 목적지를 바이트 단위로 비교한다. 이미 정확히 같으면 복사를
  시도하지 않는다. 복사가 실패했을 때 기존 파일을 유지할 수 있는 경우는 Windows
  `ERROR_SHARING_VIOLATION`이면서 실패 뒤에도 내용이 정확히 같은 경우뿐이다. 일반
  `ERROR_ACCESS_DENIED`를 포함한 다른 오류나 다른 내용은 빌드를 실패시킨다.
- `tauri.windows.conf.json`의 resource map은 installer bundling의 정본으로 유지한다.
  build script 안에서 호출하는 `tauri-build`에는 ConPTY 두 resource를 JSON merge
  tombstone으로만 제외해 dev 대상에 다시 복사하지 않게 한다. 부모 Tauri CLI의 설정은
  바꾸지 않으며 다른 bundle resource는 보존한다.
- 번들 `1.23.251008001`의 출력 계약에는 ADR-0026이 제거하던 host resize repaint가
  없다. 위 실패 정책 때문에 지원 Windows 빌드에서 legacy in-box 런타임은 도달할 수
  없는 상태이므로, 활성 조건을 계산하는 술어를 남기는 대신 **ADR-0026의 스트리밍
  repaint filter와 그 배선·테스트를 삭제한다.** 조건부로 남기면 만족될 수 없는
  술어가 "조건이 맞으면 무장한다"로 읽혀 정상 TUI redraw를 삭제하는 경로가 되살아날
  수 있다. legacy in-box 런타임을 다시 명시적으로 지원한다면 알고리즘을 git 이력
  (ADR-0026 도입 시점의 `ui/src/lib/conpty-resize-repaint-filter.ts`)에서 되살린다.
- ADR-0026의 공통 fit 스케줄러, parser queue drain, Windows quiet window, remote 복귀
  resize 재시도, xterm reflow patch는 유지한다. remote 복귀 resize는 더 이상 repaint
  filter arm을 동반하지 않고 `cols/rows` 동기화와 재시도 규칙만 남는다. Rust OSC
  파이프라인과 raw output ring, Linux 동작도 변경하지 않는다.

## Alternatives Considered

- **hide→home→show 프레임 안의 바이트를 더 분석해 host와 TUI를 구분** — 두 생산자가
  같은 VT 시퀀스를 사용할 수 있고 스트림에는 provenance가 없다. 새 런타임이 애초에
  host frame을 만들지 않으므로 휴리스틱을 늘릴 이유가 없다. 기각.
- **legacy filter 구현을 남기고 활성 정책만 분리** — 향후 in-box 진단 빌드에 재사용할
  수 있다는 이유였지만, 실제로는 도달 불가능한 술어가 남아 다음 사람이 "정교하게
  고치면 켜진다"로 읽는다. 되살릴 때 필요한 것은 알고리즘이고 그것은 git 이력에 있다.
  기각.
- **`CONPTY_REPAINT_FILTER_ENABLED = false` 같은 단일 상수로 축소** — 도달 불가능성이
  코드에 보이는 점은 낫지만 죽은 상태 머신과 배선이 그대로 남는다. 내부 개발 단계에서는
  레거시를 이고 가지 않는다. 기각.
- **미지원 아키텍처에서 경고 후 in-box conhost로 폴백** — 터미널은 뜨지만 `OSC 10/11`
  계약이 조용히 사라져 색상 문제로만 드러난다. 지원 범위를 빌드에서 명확히 실패시키는
  쪽이 재현 가능성과 출시 안전성에 유리하다. 기각.
- **dev 실행 파일 배치도 `tauri-build`에 맡김** — 동일 파일이어도 Tauri가 무조건
  `fs::copy`를 호출하므로 로드된 DLL에서 재빌드가 실패한다. 기각.
- **복사 실패 시 크기 또는 mtime만 비교** — 서로 다른 PE가 같은 크기를 가질 수 있고
  mtime은 복사·체크아웃 과정에서 신뢰할 수 없다. 파일당 약 1.3MB라 직접 바이트 비교의
  비용이 작고 별도 digest 의존성도 필요 없다. 기각.

## Consequences

- active TUI resize 직후의 첫 정상 redraw가 stale host frame으로 오인되어 사라지지 않는다.
- live 출력 경로에서 필터 상태 머신과 arm token 배선이 사라져 PTY 청크가 xterm write
  FIFO로 직행한다. 반면 legacy in-box 런타임을 다시 지원하려면 알고리즘 복원이 선행
  작업으로 필요하다.
- 같은 버전의 DLL을 실행 중인 dev 인스턴스를 둔 채 build script가 재실행돼도 목적지
  복사와 Tauri의 재복사를 모두 건너뛴다. 반대로 벤더 버전이 바뀌었는데 옛 DLL이
  잠겨 있으면 안전하게 빌드가 실패하므로 dev 인스턴스를 종료한 뒤 다시 빌드해야 한다.
- read-only ACL, 디스크 부족, 잘못된 목적지처럼 sharing 이외의 실패와 같은 크기의 stale
  파일은 더 이상 승인되지 않는다.
- i686 등 지원 표 밖의 Windows 타깃은 터미널 기능 일부만 조용히 잃는 대신 명확한
  build error를 낸다. 새 아키텍처를 지원하려면 두 벤더 파일과 아키텍처 매핑을 함께
  추가해야 한다.
- build-time Tauri 설정 overlay가 추가되지만, 단위 테스트가 ConPTY key 제거와 다른
  resource 보존을 검증하고 잠긴 DLL을 잡은 실제 cargo check가 이중 복사 회귀를 검증한다.
- ConPTY 버전을 올릴 때는 normal buffer+scrollback 폭 변경의 raw PTY 출력을 다시
  측정한다. 새 버전이 host repaint를 다시 내보내면 런타임 계약을 갱신하고, 필터를
  git 이력에서 복원할지 새 계약에 맞춰 다시 설계할지 그 시점에 판단한다.
