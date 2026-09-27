# Remote Direct 조합 중 keydown에 의한 단어 중복 조사

- 문서 범위: 최초 조사·재현의 근거를 보존하고, 사용자의 수정 PR·머지 요청에 따른 구현을 [후속 수정](#후속-수정)에서 구분해 기록한다. 아래 조사 결과와 자산 해시는 수정 전 기준 코드의 결과다.
- 조사일: 2026-09-27
- 기준: 최신 `main`의 `c8dd28c3`와 해당 커밋의 배포용 Remote xterm 자산
- 사용자 관측: Android 앱의 Direct 입력에서 `이미 이미`, `대해 대해`처럼 단어가 간헐적으로 중복된다. 물리 키보드에서 훨씬 자주 발생하며 소프트웨어 키보드에서도 드물게 나타나는 것으로 보인다.
- 최초 조사 단계는 구현을 바꾸지 않았으므로 ADR이 불필요했다. 후속 수정은 [ADR-0274](adr/0274-immediate-composition-delivery-ledger.md)로 [ADR-0093](adr/0093-xterm-composition-keypress-reconciliation-owner.md)·[ADR-0230](adr/0230-xterm-compositionend-data-recovers-replaced-textarea.md)·[ADR-0268](adr/0268-remote-ime-shares-composition-reconciliation.md)의 즉시 송신 기록과 native 조합 경계를 확장한다.

## 결론과 확인 범위

조사 기준 Remote xterm에는 **조합 중 일반 keydown이 텍스트를 먼저 보낸 뒤, 같은 조합의 `compositionend`가 그 텍스트를 다시 보내는 결함**이 남아 있었다. 실제 배포 자산을 Chromium에 로드하고 CDP의 IME 입력 및 실제 브라우저 키 이벤트를 사용해 `이미 이미 `를 재현했다. 이 재현에서는 Remote HTTP 큐에 도달하기 전 `Terminal.onData`에서 이미 중복이 생긴다.

이는 코드 결함의 확정 재현이다. 사용자의 Android System WebView·키보드가 같은 이벤트 순서를 실제로 만들었는지는 아직 확인하지 않았다. 물리 키보드에서 더 빈번하다는 관측과 부합하지만, 그 관측만으로 사용자 기기의 원인까지 확정하지 않는다.

## 중복이 만들어지는 상태 전이

구현은 [`ui/scripts/patch-xterm-reflow.mjs`](../ui/scripts/patch-xterm-reflow.mjs)의 공통 CompositionHelper 패치이며, 실행 자산은 [`src-tauri/src/remote_server/assets/xterm.js`](../src-tauri/src/remote_server/assets/xterm.js)다.

1. `compositionstart`와 `compositionupdate` 이후 helper는 `_isComposing = true`이고 textarea에는 `이미`가 있다.
2. `Space`처럼 제외 목록에 없는 `keydown`이 오면 `CompositionHelper.keydown()`이 `_finalizeComposition(false)`를 호출한다. 이 경로는 현재 textarea 범위의 `이미`를 즉시 `triggerDataEvent`로 보내고 `_isComposing`을 내린다.
3. 즉시 보낸 조합의 소비 이력은 기록하지 않는다. `_dataAlreadySent`도 이 경로에서 갱신하지 않는다. Space의 후속 `keypress`는 공백을 별도로 보낼 수 있다.
4. 브라우저가 이어서 같은 조합의 `compositionend("이미")`를 보내면 `_finalizeComposition(true)`가 새 pending generation을 만든다. 이 경로는 앞선 immediate finalize가 같은 조합을 이미 보냈는지 검사하지 않는다.
5. deferred flush는 textarea 후보와 `compositionend.data`를 병합한다. 재현에서는 textarea가 `이미 `이므로 `이미 `를 다시 보낸다.

| 순서                                            | `onData` 출력 | 누적 출력    |
| ----------------------------------------------- | ------------- | ------------ |
| 조합 중 Space keydown이 immediate finalize 호출 | `이미`        | `이미`       |
| Space keypress                                  | ` `           | `이미 `      |
| 뒤늦은 compositionend의 deferred flush          | `이미 `       | `이미 이미 ` |

`compositionend`가 먼저 도착하는 기존 테스트 순서와, 조합 중 keydown이 먼저 도착하는 이 순서는 서로 다른 가지다. 후자는 pending generation이 만들어지기 전에 조합을 한 번 송신한다. 단순히 이벤트 사이 시간이 길어진 경우만의 문제가 아니다.

동일한 즉시 확정·후속 확정 중복은 [xterm.js PR #6041](https://github.com/xtermjs/xterm.js/pull/6041)에서도 설명한다. 해당 PR은 병합되지 않고 닫혔으며 후속 [PR #6140](https://github.com/xtermjs/xterm.js/pull/6140)이 있다. upstream 설명은 독립적인 참고 근거이고, 위 결론은 이 저장소의 실제 배포 자산을 실행한 결과다.

## CDP IME·브라우저 키 최소 재현

Windows의 `ui/`에서 설치된 Playwright와 Chromium을 사용했다. 배포 자산의 SHA-256은 `ce4fce782ba87c35d26ae356b9986fdc879f31334e3daef53737472dd3e60e35`다. 이 값은 #1086에서 수정한 자산의 해시와 같다. 따라서 이전 자산을 잘못 로드해서만 발생한 재현이 아니다.

아래 코드는 `ui/`를 현재 디렉터리로 하는 Node 스크립트로 실행한다. CDP `Input.imeSetComposition`으로 조합을 시작하고 `page.keyboard.press("Space")`로 실제 브라우저 키 이벤트를 전달한 다음 CDP `Input.insertText`로 조합을 확정한다. `dispatchEvent`로 DOM 이벤트를 직접 합성하지 않는다.

```js
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="terminal" style="width:800px;height:400px"></div>',
    );
    await page.addScriptTag({
      path: path.resolve("../src-tauri/src/remote_server/assets/xterm.js"),
    });
    await page.evaluate(() => {
      window.term = new Terminal({ cols: 80, rows: 25 });
      term.open(document.getElementById("terminal"));
      term.focus();
      window.chunks = [];
      term.onData((data) => chunks.push(data));
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "\uC774\uBBF8",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await page.waitForTimeout(10);
    await page.keyboard.press("Space");
    await cdp.send("Input.insertText", { text: "\uC774\uBBF8" });
    await page.waitForTimeout(10);
    console.log(await page.evaluate(() => ({ chunks, text: chunks.join("") })));
  } finally {
    await browser.close();
  }
})();
```

기준 코드에서 결과는 `{ chunks: ["이미", " ", "이미 "], text: "이미 이미 " }`다. 타이머 대기는 compositionupdate의 범위 저장과 마지막 deferred flush를 실행시키기 위한 것이다. 네트워크나 서버는 이 최소 재현에 관여하지 않는다.

이 방식은 Chromium의 편집 경로를 사용하지만 호출 순서를 CDP가 정한다. 실제 기록에서 keydown·keypress·keyup·compositionstart·compositionupdate·input은 `isTrusted: true`였으나 CDP 확정이 생성한 `compositionend`는 `isTrusted: false`였다. 따라서 전체 시퀀스를 trusted 입력으로 부르면 안 되며, Android 실기 IME가 스스로 만드는 입력 시퀀스와 빈도를 측정한 것으로 해석하면 안 된다.

## 수정 전 실제 dev 서버·PTY 확인

실제 dev 19281이 제공하는 Remote 페이지에서도 입력 순서만 바꿔 `/write` 본문과 ConPTY raw stdin을 대조했다. 입력 이벤트에서 생긴 중복이 실제 터미널 입력까지 전달됨을 확인했다.

- health: `buildKind: dev`, 포트 `19281`, PID `79740`, 버전 `1.0.20`.
- worktree: `D:\PycharmProjects\laymux-remote-input-investigation`, 브랜치 `fix/remote-direct-input-root-cause`, 커밋 `c8dd28c3491c0e10bcd56f216fe7362d37adff12`.
- served 자산: `/remote/asset/xterm-ce4fce782ba87c35.js`. 응답의 SHA-256이 위 main 자산과 일치했다.
- 앱 데이터와 WebView 저장소는 `.tmp/ime-investigation/` 아래로 격리했다. Vite `1434`, WebView CDP `9234`를 사용했다. 실행 파일은 공유 빌드 캐시인 `laymux-dev/target/debug/laymux.exe`에 있으므로 경로만으로 코드를 식별하지 않고 health의 worktree·커밋을 확인했다. release 19280은 조작하지 않았다.
- terminal pane에서 `.tmp/ime-investigation/receiver.cjs`를 실행했다. stdin을 raw 모드로 열어 수신 바이트를 파일에 append했다.

| CDP·브라우저 키 순서 | 입력 `/write` 본문 | ConPTY raw stdin |
| -------------------- | ------------------ | ---------------- |
| 조합 → 확정 → Space  | `이미 `            | `이미 `          |
| 조합 → Space → 확정  | `이미 이미 `       | `이미 이미 `     |

중복 사례의 `onData`는 `['이미', ' ', '이미 ']`이고 입력 큐가 합산한 **한 번의** `/write`가 이미 `이미 이미 `였다. HTTP 재전송으로 같은 write가 두 번 실행된 것이 아니다. 첫 비교의 입력 전에 관측된 별도 focus-report `ESC [ I` 쓰기는 문장 입력과 구분했다.

측정 JSON은 `.tmp/ime-investigation/dev-result.json`, 화면은 같은 디렉터리의 `end-before-space.png`와 `space-before-end.png`다. `.tmp`는 로컬 조사 산출물이며 저장소 배포 파일이 아니다. 판정 근거는 스크린샷에 보이는 글자만이 아니라 `onData`·전송 본문·실제 stdin의 일치다. 앞 절의 `compositionend.isTrusted: false` 및 Android 실기 미검증 한계는 이 통합 검증에도 그대로 적용한다.

## 이전 PR이 통과한 이유

[#1086의 재현 기록](remote-ime-duplicate-input-repro-2026-09-27.md)은 Remote 번들에 빠졌던 공통 조합 패치를 적용하고, `compositionend → input(insertText) → deferred finalizer` 경합을 해소한 결과다. 그 수정 자체가 없었던 것으로 판정하는 것은 아니다.

그러나 [`remote-ime-preedit.spec.ts`](../ui/e2e/remote-ime-preedit.spec.ts)의 `commitWords`는 조합을 끝낸 뒤 같은 단어의 input과 선택적인 keypress를 넣는다. 조합 중 `Space`·`Enter` keydown이 먼저 발생하는 경로가 없다. 공통 [`xterm-ime-composition-reconcile.test.ts`](../ui/src/lib/xterm-ime-composition-reconcile.test.ts)의 일반 keydown 사례도 `compositionend` 뒤 pending FIFO를 비우는 경우이며, 아직 진행 중인 조합의 immediate finalize 뒤 native end가 오는 경우와 다르다.

HTTP 지연 0ms·150ms, 별도 조합의 의도적 반복, blur 검증은 이 빠진 이벤트 순서를 대신하지 못한다. 기존 문서의 수정 완료 표현은 당시 재현한 순서와 자산 차이에 대한 결과로 읽어야 한다. 모든 Android 키보드 순서의 중복이 해소됐다는 보장은 아니다.

## 최초 조사 단계의 자동 검증

- 기존 공통 조합·설치 계약 테스트 44개가 그대로 통과했다. 이 결과는 이번에 발견한 입력 순서를 기존 테스트가 탐지하지 못함을 보여준다.
- `remote-ime-preedit.spec.ts` 기존 9개와 `remote-ime-android-investigation.spec.ts` 신규 7개를 함께 실행했다. 기존 9개와 순서 대조군 3개는 일반 통과, 중복 경로 4개는 `test.fail()`로 표시한 알려진 실패다. 실행기가 보고하는 16개 정상 종료를 결함 수정 완료로 해석하면 안 된다.
- 신규 테스트는 0·1·20ms 간격의 keydown 선행·후행을 비교하고, CDP의 편집 경로에서 단일 `/write` 본문 `이미 이미 `를 확인한다. 알려진 실패는 정상적인 단일 전송을 기대하므로 향후 수정 시 `test.fail()`을 제거해야 한다.
- 신규 테스트 ESLint, 신규 테스트·조사 문서 Prettier, `git diff --check` 통과. production 코드는 수정하지 않았다.

## 전송 계층 조사

별도 독립 조사에서 다음을 확인했다.

- `ensureTerminal()`은 기존 인스턴스가 있으면 반환하며 `onData` 등록은 인스턴스당 한 번이다. Remote 입력 큐는 12ms 동안 모은 데이터를 비우고 단일 Promise 체인으로 보내며 HTTP 실패 후 같은 입력을 자동 재전송하지 않는다.
- 실제 큐 함수를 추출해 불규칙 flush·지연 응답으로 1만 입력 이벤트, 4만 글자를 처리했다. 673회 쓰기의 최종 문자열이 원본 4만 글자와 정확히 일치했다. 이는 추출한 큐의 검증이며 Android부터 PTY까지의 통합 검증은 아니다.
- Android native bridge는 물리 키를 별도 입력 경로로 전달하지 않는다. E2E 전송은 동일 ciphertext를 재시도하고 서버는 sequence와 ciphertext digest가 같은 요청에 캐시된 응답을 반환해 write dispatch를 다시 실행하지 않는다.

이 조사 범위에서는 전송 계층이 입력을 복제하는 근거를 찾지 못했다. 무엇보다 최소 재현의 `onData`가 이미 중복되어 있으므로 재현한 결함을 전송 재시도로 설명할 필요가 없다. Android SDK가 기본 경로와 PATH에 없어 JVM 테스트는 이번 조사에서 재실행하지 않았다.

## 수정 구현에 필요한 조건

최초 조사 단계에서는 production 코드를 수정하지 않았다. 당시 도출한 조건은 공통 CompositionHelper 안에서 한 조합의 즉시 송신과 후속 확정을 함께 추적해야 한다는 것이다. Remote 큐에 단어·시간창 기반 필터를 추가하면 별도 조합의 정상적인 반복도 잃는다.

upstream에서 제안한 것처럼 `_dataAlreadySent`에 즉시 보낸 길이만 더하는 수정도 이 저장소에는 충분하지 않다. [ADR-0230](adr/0230-xterm-compositionend-data-recovers-replaced-textarea.md)의 복원 경로가 textarea slice와 전체 `compositionend.data`를 병합하므로, slice에서 제거한 이미 보낸 문자열을 확정 후보가 다시 살릴 수 있다. 반대로 모든 뒤늦은 end를 버리면 keydown 이후 IME가 새로 확정한 부분이나 Windows textarea 전체 교체의 복구를 잃을 수 있다.

구현과 함께 다음 구분을 고정해야 한다.

- 조합 중 `Space`·`Enter` keydown 선행과 `compositionend` 선행 모두 조합을 한 번만 보낸다. 이미 보낸 separator도 재전송하지 않는다.
- immediate finalize 이후 IME가 추가 확정한 내용은 보존한다. 이미 보낸 조합을 event-data 복원이 되살리지 않는다.
- Windows의 textarea 전체 교체, pending FIFO, 229 diff 방어, blur 전 flush와 blur 뒤 취소를 유지한다.
- 다음 `compositionstart`로 시작한 별도 조합의 동일한 단어는 정상 입력으로 각각 보낸다.
- 실제 ESM·데스크톱 CJS·Remote CJS 및 Remote `/write` 경로에서 동일한 이벤트 순서를 검증한다.

소유권·불변식이 현재 ADR의 결정 범위를 확장하면 구현 전에 새 ADR과 `docs/architecture/data-flow.md` §8.14를 함께 정리한다. 기존 Accepted ADR의 내용을 덮어쓰지 않는다.

## 후속 수정

사용자의 수정 PR·머지 요청에 따라 공통 CompositionHelper에 native 조합별 송신 기록을 추가한다([ADR-0274](adr/0274-immediate-composition-delivery-ledger.md)). 즉시 보낸 prefix는 불변으로 보존하고, native 종료 전 input으로 보낸 추가 관측은 별도로 누적한다. 뒤늦은 `compositionend`는 같은 native 기록을 공유하므로 textarea·이벤트 데이터·관측 복원을 모두 끝낸 뒤 이미 보낸 부분을 제외한다. Enter 뒤 textarea가 일반 input으로 통째로 교체돼도 원래 조합의 송신 이력을 덮어쓰지 않는다.

Enter·Ctrl-C의 실제 Core textarea clear 직전에 `textareaCleared()`로 경계를 알린다. clear 이후 일반 입력의 관측은 새 record로 시작하되, 원래 native prefix와 관측 기록은 참조로 유지하고 당시 native 관측은 고정 스냅샷으로 보관한다. 따라서 clear 전에 전달된 native suffix가 늦은 종료에서 재전송되지 않고, clear 뒤 같은 글자의 일반 입력도 살아남는다. Core input은 `isComposing`을 helper에 넘겨 native 관측 여부를 구별한다. clear 뒤 일반 input은 원래 prefix를 빼지 않으며, native 관측·종료는 보존한 native 기록을 먼저 갱신한다. 그 누적 관측에서 clear 당시 스냅샷만 제외해 clear 이후 기록과 병합하므로, `글` → `글글`의 확장을 직전 차이인 `글`의 중복으로 잘못 지우지 않는다. 반복 clear도 같은 원래 native 기록을 유지한다.

native 종료 전 input은 이벤트마다 기존 FIFO의 임시 generation을 만들고, 해당 input의 `isComposing`과 textarea 스냅샷을 즉시 고정한다. timer 전에 native 관측과 일반 input이 교차하더라도 각각의 조합 여부와 후보 문자열이 섞이지 않는다. 새 delayed generation을 만들기 전에 이전 pending 스냅샷을 확정하는 경계도 유지한다. 일반 keypress는 helper가 즉시 보낸 뒤 consumed로 반환한다. CoreBrowserTerminal이 기존 consumed 처리로 기본 삽입을 취소하므로 Space를 이미 전송한 뒤 textarea에도 남겨 native 종료에서 되풀이하던 경로가 사라진다. native 종료·다음 조합 시작·helper blur는 기록의 연결을 해제하며, 각 pending generation이 보유한 기록은 해당 generation의 flush까지 유지된다.

구현은 [`xterm-composition-lifecycle.mjs`](../ui/scripts/xterm-composition-lifecycle.mjs)의 공통 메서드를 기존 exact bundle 설치 관문에 연결한다. ESM·데스크톱 CJS·Remote CJS가 같은 경계를 사용하며 Remote 전송 큐에는 문자열·시간창 필터를 추가하지 않는다. 설치 관문은 이전 패치에서의 갱신과 재실행을 검사한다.

최초 조사에서 알려진 실패로 남긴 이벤트 순서는 [`remote-ime-keydown-commit.spec.ts`](../ui/e2e/remote-ime-keydown-commit.spec.ts)의 정상 회귀 기대값으로 전환한다. 공통 실제 Terminal 테스트에는 Space·Enter 선행, 종료 전 일반 input, Enter·Ctrl-C clear 전후 native suffix와 일반 입력의 분리, textarea 전체 교체, 늦은 native 종료, generation 스냅샷 분리, helper blur, 다음 조합의 같은 단어 보존을 포함한다. 이 회귀 검증과 Android 실기 입력 순서·발생 빈도의 확인은 별도다. 데스크톱 TerminalView의 별도 blur fallback까지 포함한 전체 앱 입력 경로도 helper 자체의 blur 검증과 구분한다. native 종료 데이터 자체가 separator를 포함하는 경우와 모호한 다문자 overlap에는 선행 관측 병합의 구별 한계가 남는다.

## 수정 후 검증

브라우저 E2E는 배포 Remote 자산 → `Terminal.onData` → mock HTTP 서버의 `/write` 본문을 검증한다. 이후 자체 dev 19281을 실행해 수정된 자산이 실제 서버에서 제공되는지 확인하고 동일한 CDP·브라우저 키 순서를 실제 ConPTY raw stdin까지 다시 측정했다.

- health: `buildKind: dev`, 포트 `19281`, PID `71904`, 버전 `1.0.20`.
- worktree: `D:\PycharmProjects\laymux-remote-input-investigation`, 브랜치 `fix/remote-direct-input-root-cause`.
- 빌드 기준: `96ada4613aaa34e0c58f7ddacf490198f5a80744`와 이 수정의 작업 diff. health의 `gitCommit`만으로 미커밋 변경 적용을 주장하지 않고 제공 자산의 해시를 함께 확인했다.
- served 자산: `/remote/asset/xterm-062f08753e297c9b.js`. 실제 응답과 수정된 소스 자산의 SHA-256이 모두 `062f08753e297c9b572d01c4afb708c7663f8e6fa489b9cc30b525447666fa7d`로 일치했다.

| CDP·브라우저 키 순서 | 수정 후 `onData` | 수정 후 `/write` 본문 | 실제 ConPTY raw stdin |
| -------------------- | ---------------- | --------------------- | --------------------- |
| 조합 → 확정 → Space  | `이미`, ` `      | `이미`, ` `           | `이미 `               |
| 조합 → Space → 확정  | `이미`, ` `      | `이미 `               | `이미 `               |

첫 대조군에는 문장 입력 전의 focus report `ESC [ I`가 별도 `onData` 및 `/write`로 관측됐다. 표는 이 프로토콜 입력을 구분한 문장 입력 결과이며, 원본 JSON에는 해당 report도 그대로 남겼다. 두 순서 모두 입력의 누적 문자열과 실제 raw stdin이 `이미 `로 일치했다. Space 선행의 수정 전 결과 `이미 이미 `가 수정 후 `이미 `로 바뀌었다.

측정 결과는 `.tmp/ime-investigation/dev-result-after.json`에 있다. 수정 후 스크린샷은 대조군과 실험군을 각각 실행한 두 결과가 누적되어 보이므로, 화면에 같은 단어가 두 번 보인다는 사실을 한 입력의 중복으로 판정하지 않는다. 판단 근거는 각 실행별 `onData`·`/write`·실제 stdin의 일치다. CDP 확정의 `compositionend.isTrusted: false` 및 Android 실기 입력 순서·빈도 미검증 한계는 수정 후 측정에도 그대로 적용한다.

최종 자동 검증은 관련 unit 5개 파일 246개와 브라우저 E2E 28개(이번 keydown 회귀 7개, 기존 IME 9개, 물리 키보드 12개)가 통과했다. UI 빌드, 변경 파일 lint·Prettier, 설치 패치 재실행 시 불변성도 확인했다. 기존 README와 living doc 전체의 Prettier 경고는 기준 HEAD에도 존재해 대량 포맷 변경을 하지 않았다.

## Android 실기 및 배포 확인의 남은 범위

Android 앱은 PC의 Remote 자산을 받지만 foreground 복귀 시 열린 문서를 보존할 수 있다. PC를 업데이트해도 기존 문서가 이전 xterm을 실행할 수 있으므로 실제 문서의 `/remote/asset/xterm-<hash>.js`와 PC 버전·커밋을 함께 확인해야 한다. 자산 URL은 내용 해시를 포함하고 셸은 `no-store`이므로, 이를 곧바로 HTTP 캐시 고장으로 단정하지 않는다.

실기에서 수집할 기록은 `keydown/keypress/keyup`, `compositionstart/update/end`, `beforeinput/input`의 순서와 `keyCode`, `isComposing`, `inputType`, textarea 값·선택 범위, `onData`, `/write` 본문이다. 물리·소프트웨어 키보드를 분리해 동일한 단어 중복 순간과 대조해야 한다. 입력 텍스트가 포함되므로 재현용 문장으로 기록한다.

최초 조사로 #1086 수정 자산에도 별도의 조합 수명주기 결함이 남아 있음을 확인했고, 후속 수정은 그 경로의 송신 소유권을 확장한다. 사용자 기기에서 이전 문서 유지까지 겹쳤는지, 또는 다른 IME 이벤트 경합도 있는지는 아직 미확인이다.
