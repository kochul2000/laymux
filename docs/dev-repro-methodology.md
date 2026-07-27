# dev 재현 방법론 — 화면으로 보이는 결함을 고치는 절차

키보드·IME·커서·렌더링처럼 **눈으로는 보이는데 코드로는 안 보이는** 결함을 다룰 때의 절차다. issue #527·#529·#532·#533·#534·#543·#551·#553·#554·#555·#558·#560 을 이 방식으로 처리했고, 그 과정에서 확인된 것만 적는다.

진입점 한 줄은 [`AGENTS.md`](../AGENTS.md) 의 "자율 검증 루프" 에 있다.

## 왜 이 절차인가 — 코드 독해는 이 계층에서 잘 틀린다

#551/#552 에서 확인된 결함 6개의 출처:

| 출처                            | 개수 |
| ------------------------------- | ---- |
| `cursor-trace` 계측 로그        | 2    |
| 사용자가 실기에서 타이핑        | 2    |
| 리뷰어가 실제 xterm 번들을 실행 | 1    |
| 코드 독해                       | 1    |

같은 기간 **코드만 읽고 내린 진단 3개가 틀렸다.** 전부 "화면에 커서가 보이니 X 일 것" 류의 추론이었다. 스크린샷은 결과만 보여주고 원인 계층의 상태(어느 커서가 권위인지, 어느 프레임에서 앵커를 잡았는지)는 보여주지 않는다.

**규칙: 결함이 사는 계층에서 측정한다.** 추론으로 진단을 확정하지 말고, 그 계층의 값을 찍어서 확인한다.

## 1. dev 인스턴스에 재현 환경을 만든다

- **포트로 구분한다.** release=19280(사용자 소유, 건드리지 않음), dev=19281. 창 제목은 둘 다 `Laymux` 라 제목으로 고르면 **release 에 입력이 들어간다** — 실제로 한 번 그랬다. 프로세스는 포트로 찾는다:
  ```powershell
  Get-NetTCPConnection -LocalPort 19281 -State Listen | Select-Object -Expand OwningProcess
  ```
  포그라운드 확인도 프로세스 **이름이 아니라 pid** 로 한다.
- **dev 기동은 워크트리에서 `cargo tauri dev`, 종료는 `bash scripts/kill-dev.sh`.** 브랜치 코드를 실기에서 보려면 그 워크트리에서 띄운다. 새 워크트리는 `ui/` 에서 `npm ci` 가 필요하다(xterm 패치가 postinstall 로 붙는다).
- **재현 환경은 끝까지 세팅해 놓는다.** "vim 을 띄우고 insert 모드까지 들어간 pane" 처럼, 사용자가 할 일이 **키 몇 번**만 남도록 만든다. MCP `write_to_terminal` 로 앱 실행·모드 진입까지 미리 해둘 수 있다.

## 2. 사람이 해야만 하는 입력을 구분한다

자동화로 만들 수 **없는** 입력이 있다. IME 조합(`compositionstart`/`update`/`end`)은 OS IME 가 만드는 것이라 PTY 쓰기로 재현되지 않는다. 포커스 아웃, 실제 클립보드, 물리 키의 modifier 조합도 마찬가지다.

이 중 일부는 **Windows 에서 도달 가능하다.** `scripts/devinput/` 이 SendInput 으로 OS 입력 큐에 진짜 키를
넣는다(합성 DOM 이벤트가 아니다). 현재 1단계 — 물리 키·modifier 조합까지. 클립보드·포커스 아웃·IME 는
아직 사람 몫이다. 쓰려면 사용자가 PC 를 명시적으로 넘겨야 한다(lease):
`uv run scripts/devinput/cli.py lease 15m --focus-dev` → `doctor` → 시나리오. 사람이 키를 누르거나 마우스를
움직이면 즉시 중단된다. 절차·안전 장치는 [`scripts/devinput/README.md`](../scripts/devinput/README.md).

**하드웨어 조건**(저사양 GPU·소프트 렌더링), **시각 판단**("겹친 거냐 치환된 거냐"), **macOS/Linux IME** 는
자동화 밖이다. 그리고 lease 가 없을 때는 아래 경로가 정본이다.

사용자에게는 **정확한 시퀀스**를 준다 — 몇 번째 키에서 무엇을 봐야 하는지까지. 좋은 요청의 형태:

> pane 3 (`lx:pane:Default:3`) 포커스 → Ctrl+Alt+M → `ㄱ` 을 세 번 → 세 번째에서 `ㄱㄱㄱ` 인지 `ㄱㄱ` 인지

관찰 결과는 그대로 받아 적고 해석을 덧붙이지 않는다. "ㄱㄱ 에서 멈춘다", "커서가 줄커서로 보인다" 같은 진술이 진단을 여러 번 뒤집었다.

## 3. 모호하면 계측을 켠다

```
VITE_LAYMUX_CURSOR_TRACE=1   # UI 이벤트를 rAF 단위로 묶어 Rust tracing 으로 전달
LAYMUX_PTY_TRACE=1           # PTY 측 기록
```

- 로그 파일은 **UTF-16LE** 다. 그냥 읽으면 깨진다 — 디코드해서 읽어라.
- 애매했던 케이스는 **전부** 이 트레이스로 종결됐다(`shadow-sync-skip {reason:"inactive", bufferAbsY:257, shadowAbsY:256}` 한 줄이 앵커 권위 문제를 확정한 식).
- 가설이 둘 이상이면 토론하지 말고 켜라. 켜는 비용이 틀린 진단 하나보다 싸다.

## 4. 순수 함수로 판정을 뽑는다

판정(어느 커서가 권위인가, 이 키는 누구 것인가)을 컴포넌트 밖 순수 함수로 꺼내면 실기 없이 표로 고정할 수 있다. `advanceCells`, `resolveVisualCaretOwner`, `isComposerKeyProxyActive` 가 그렇게 나왔다.

**판정 소유자는 하나여야 한다.** 같은 질문에 두 곳이 답하면 반드시 갈라진다 — #552 의 앵커(shadow vs 버퍼), #560 의 "초안이 비었나"(prop vs ref)가 각각 그 실패였다.

## 4.5. 셀 격자로 판정한다 — 화면 주장은 실제 xterm 에 흘려서 본다

순수 함수로 못 빼는 판정이 있다. **"이 바이트를 흘리면 화면이 이렇게 된다"** 는 파서와 버퍼가 있어야 답이 나온다. `TerminalView.test.tsx` 는 xterm 을 mock 하므로 여기서는 아무것도 단정할 수 없다 — mock 의 `write` 는 문자열을 기록할 뿐 파서에 닿지 않고, `reset` 은 버퍼를 비우지도 `onScroll` 을 쏘지도 않는다.

그래서 `open()` 하지 않은 **실제 `@xterm/xterm`** 에 바이트를 흘려 `buffer.active` 를 읽는 계층을 따로 둔다([ADR-0074](adr/0074-xterm-cell-grid-screen-test-tier.md)).

```bash
cd ui && npm run test:screen     # *.screen.test.ts 만 — 기본 vitest run 에서는 제외된다
```

- 하니스: `ui/src/test/screen/` — 표면(`xterm-screen.ts`), 백엔드 ring 대역(`output-ring.ts`), 차분 프레임 스크립트(`differential-frames.ts`), output 경로 드라이버(`output-surface-driver.ts`).
- 셀 단위로 비교한다(문자·폭·색·속성·커서). 행 문자열만 보면 SGR 손실과 전각 continuation 붕괴를 놓친다.
- 폭은 프로덕션과 같은 provider 를 쓴다(`activateTerminalUnicodeProvider`, ADR-0058). 첫 write 앞에서 등록하지 않으면 출하되는 것과 다른 격자를 재게 된다.
- **결함의 존재 증명이 1급 시민이다.** 비교 함수는 던지지 않고 차이를 돌려주므로 "이 경로로는 복원되지 않는다" 를 그대로 단정할 수 있고, 그러려면 **폐기한 경로를 실행 가능한 상태로 유지**해야 한다(대조군).
- 컴포넌트를 렌더하지 않는다. `TerminalView` 가 그 순서로 배선했는지는 계속 `TerminalView.test.tsx` 가 소유한다. 어느 쪽에 쓸지는 "xterm 실동작이 주장의 일부인가" 로 가른다.

실기(§1–§3)를 대체하지 않는다. 이 계층은 **반복 가능한 회귀**를 담당하고, 폰트·렌더러·OS IME 는 여전히 dev 실기의 몫이다.

## 5. 사보타주 검증 — 테스트가 결함을 못박고 있지 않은지

수정을 되돌려 **의도한 테스트가 실제로 실패하는지** 확인한다. 통과하면 그 테스트는 아무것도 지키지 않는다.

이번 기간에 **기존 테스트 5개가 결함을 "정상" 으로 못박고 있었다** — `"prioritizes alt buffer before all other visual owners"` 처럼, 고쳐야 할 동작이 단정문으로 적혀 있었다. 그러니 실패하는 테스트를 먼저 만들고, 기존 테스트가 반대를 주장하면 **그 테스트가 틀렸는지부터** 따진다.

## 6. 실기 확인 없이는 닫지 않는다

단위 테스트 통과는 재현 종료가 아니다. #555 의 첫 구현은 스위트를 전부 통과하고 실기에서 실패했다 — 내가 측정한 이벤트 순서(`end → flush → blur`)와 실제 순서(`end → blur → flush`)가 달랐기 때문이다. 브랜치 코드를 dev 에 띄우고, 처음 재현했던 그 시퀀스를 다시 시킨다.

## 7. 남기는 것

- **리빙독**(`docs/architecture/*.md`)에 판정·근거·**비목표**·미검증을 적는다. "고쳤다" 보다 "왜 이 분기는 안 고쳤나" 가 다음 사람에게 비싸다.
- **미검증은 미검증이라고 쓴다.** 실기로 본 조합(예: vim + Windows IME)만 검증됐다고 적고, 나머지는 추론이라고 밝힌다.
- PR → 리뷰 → 반영 → 머지 게이트. 리뷰는 우선순위를 매겨 요청한다(무엇을 의심해 달라, 무엇은 범위 밖이다).

## 반복해서 밟은 함정

- **로컬 main 이 stale.** 머지를 GitHub 에서 하면 로컬은 그대로다. 소스를 근거로 인용하기 전에 `git merge-base --is-ancestor` 로 확인하거나 `git pull --ff-only`.
- **`vitest` 를 리포 루트에서 실행** → 루트(node 환경) 설정이 잡힌다. `cd ui` 후 실행한다.
- **재사용한 워크트리의 `node_modules`** 에 xterm 패치가 없을 수 있다 → `node scripts/patch-xterm-reflow.mjs`.
- **bash `node -e "..."` 안의 백틱**은 명령 치환이 된다. 스크립트 파일로 쓰거나 작은따옴표를 쓴다.
- **테스트 목의 `viewportY` 와 `baseY` 불일치** → `isTerminalScrolledUp` 이 켜져 엉뚱한 분기를 탄다.
- **MCP `escape` 의 제어문자 처리**가 일관되지 않다. 제출은 `\r`.
- **`automation.json` 은 dev 인스턴스만 쓴다(#574 이후).** 예전에는 `cargo test` 의
  `write_and_remove_discovery_file` 이 실제 설정 경로에 port=19280 을 쓰고 지워서, 살아 있는 dev 인스턴스에서도
  파일이 사라졌다. 지금은 테스트가 `tempfile` 디렉터리를 쓰고, `kill-dev.sh` 1순위는 파일의 `port` 가 19281 일 때만
  그 pid 를 신뢰한다. 그래도 dev pid 의 최종 권위는 포트 19281 LISTENING 소유자다(`kill-dev.sh` 2순위 경로).

## 관련

- 자율 검증 루프·포트 규칙: [`AGENTS.md`](../AGENTS.md)
- Claude Code 자동 구동 절차: [`claude-code-automation.md`](./claude-code-automation.md)
- 커서/IME 정본: [`terminal/`](./terminal/), 판정 기록: [`architecture/data-flow.md`](./architecture/data-flow.md) §8.15–§8.19
