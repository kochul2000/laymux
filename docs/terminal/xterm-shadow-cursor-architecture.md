# xterm.js 섀도 커서 아키텍처 — 리페인트에서 입력 커서를 지키는 5-레이어 전략

> 2026-06-11 개정([ADR-0011](../adr/0011-dectcem-cursor-park-fifth-layer.md)): DECTCEM 커서 주차(park)를
> 5번째 레이어로 추가. 실측 근거는 `cursor-jump-evidence/` 참조.

**xterm.js는 "입력 커서"와 "애플리케이션 커서"를 구분하지 않는다.** 버퍼당 커서는 하나뿐이다. Codex·Claude Code처럼 상태 footer를 자주 리페인트하는 CLI에서 `buffer.active.cursorX/Y`는 마지막 이스케이프 시퀀스가 도착한 위치 — footer 끝 — 를 가리킨다. 해결책은 VS Code 터미널이 실제로 쓰는 **"섀도 커서(shadow cursor)" 아키텍처**다.

---

## 근본 문제

xterm.js는 버퍼마다 `(cursorX, cursorY)` 쌍을 하나만 유지한다. footer 리페인트를 위한 CSI 시퀀스든, 프롬프트에서 문자를 에코하는 시퀀스든 모두 같은 상태를 업데이트한다. VT100 이래의 설계 제약이라 버그가 아니다. "사용자가 타이핑하는 위치"와 "앱이 그리는 위치"의 분리는 xterm.js 위 상위 레이어에서만 가능하다.

---

## 6가지 접근 평가

### 접근 1 — Mode 2026 (Synchronized Output) — 필요조건

**xterm.js 6.0.0부터 지원.** `CSI ? 2026 h`(시작) ↔ `CSI ? 2026 l`(종료) 사이 렌더링을 지연. 1초 안전 타임아웃이 있다.

```typescript
terminal.parser.registerCsiHandler({ final: 'l', prefix: '?' }, (params) => {
  if (params.includes(2026)) {
    // 프레임 완성 — 이 시점에 커서 읽기가 안전
    scheduleSync();
  }
  return false; // 기본 핸들러도 실행
});
```

**한계:** 렌더링 깜빡임은 막아주지만 "어느 커서가 입력 커서인가"는 알려주지 않는다. 필요조건이지만 충분조건은 아니다.

---

### 접근 2 — OSC 133 프롬프트 감지 — 가장 강력한 신호

OSC 133(FinalTerm 셸 통합 프로토콜)이 프롬프트-명령-출력 경계를 명시적으로 표시한다. xterm.js가 내부 처리는 안 하지만 `parser.registerOscHandler(133, ...)`으로 인터셉트 가능.

```typescript
terminal.parser.registerOscHandler(133, (data) => {
  const buf = terminal.buffer.active;
  switch (data.split(';')[0]) {
    case 'A': // 프롬프트 시작
      state.isInputPhase = false;
      break;
    case 'B': // 프롬프트 끝 → ★ 여기가 사용자 입력 기준점
      state.commandStartX    = buf.cursorX;
      state.commandStartLine = buf.baseY + buf.cursorY;
      state.isInputPhase     = true;
      break;
    case 'C': case 'D': // 실행/완료
      state.isInputPhase = false;
      break;
  }
  return false;
});
```

**`OSC 133 ; B`가 발화하는 시점이 프롬프트 텍스트와 사용자 입력의 정확한 경계.** 이후 footer 리페인트가 아무리 커서를 움직여도 이 기록된 위치는 변하지 않는다.

**CLI 앱에서 내보내는 방법 (Node.js):**
```typescript
const OSC = (seq: string) => process.stdout.write(`\x1b]133;${seq}\x1b\\`);

function showPrompt() {
  OSC('A');                    // 프롬프트 시작
  process.stdout.write('> ');
  OSC('B');                    // ← 입력 커서는 여기
}
function onSubmit() { OSC('C'); }
function onDone(code = 0) { OSC(`D;${code}`); }
```

---

### 접근 3 — 파서 훅으로 이스케이프 시퀀스 인터셉션 — 핵심 보완책

파서 훅은 **파싱 중 동기적으로** 실행된다. DECSC/DECRC를 감시해 리페인트 사이클을 감지한다.

```typescript
// ESC 7 (커서 저장) → 리페인트 시작
terminal.parser.registerEscHandler({ final: '7' }, () => {
  if (state.isInputPhase) state.isRepaintInProgress = true;
  return false;
});

// ESC 8 (커서 복원) → 리페인트 종료, 복원 위치가 입력 커서
terminal.parser.registerEscHandler({ final: '8' }, () => {
  if (state.isRepaintInProgress) {
    state.isRepaintInProgress = false;
    queueMicrotask(() => {
      state.cursorX    = terminal.buffer.active.cursorX;
      state.cursorAbsY = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    });
  }
  return false;
});
```

**주의:** CR, LF, BS 같은 C0 제어문자는 공개 API로 훅 불가. `onWriteParsed`에서 버퍼를 읽어 추론해야 한다.

---

### 접근 4 — 버퍼 라인 직접 검사 — Ground truth

VS Code `PromptInputModel`이 실제로 쓰는 방식. `onWriteParsed` 이벤트에서 읽으면 파싱 완료 후 일관된 버퍼 상태를 얻는다.

```typescript
terminal.onWriteParsed(() => {
  if (state.isRepaintInProgress) return;
  if (terminal.modes.synchronizedOutputMode) return;

  const buf = terminal.buffer.active;
  state.cursorX    = buf.cursorX;
  state.cursorAbsY = buf.baseY + buf.cursorY;
  updateOverlay();
});
```

- **`onWriteParsed`**: 데이터 파싱 완료 직후, 프레임당 최대 1회. 버퍼가 완전히 업데이트된 상태 → **커서 추적에 올바른 이벤트**
- **`onCursorMove`**: 리페인트 중간 위치도 잡힌다 → **원칙적으로 사용 금지**. 단, 키 입력 즉각 반응성을 위해 최소한의 가드 조건부 사용은 허용한다(`hasPromptBoundary && isInputPhase && !isRepaintInProgress && !isAltBufferActive && !syncOutputActive`). 커서 관련 문제 발생 시 **가장 먼저 `onCursorMove` 핸들러 제거를 시도**하고, 그래도 재현되면 다른 원인을 조사한다.

---

### 접근 5 — 얼터네이트 스크린 전환 추적 — 보조 수단

```typescript
terminal.buffer.onBufferChange((buf) => {
  if (buf.type === 'alternate') {
    // 전체화면 모드 진입 → 섀도 커서 일시 중단
    shadowCursor.suspend();
  } else {
    // 노멀 스크린 복귀 → OSC 133 B 다시 기다림
    shadowCursor.resume();
  }
});
```

Claude Code의 최신 접근(`CLAUDE_CODE_NO_FLICKER=1`)은 아예 얼터네이트 스크린으로 전환해 전체 화면을 직접 제어한다. 이 경우 커서 정체성 문제 자체가 사라진다.

---

### 접근 5.5 — DECTCEM 커서 주차(park) 추적 — Codex류 TUI 의 최우선 신호

ratatui 기반 TUI(Codex 등)는 프레임을 그릴 때 `?25l`(hide)로 시작해 `?25h`(show)로 끝내고,
**프레임 flush 직후 별도 청크로 `?25l` + CUP + `?25h`(hide–move–show)를 보내 보이는 커서를
입력 위치에 "주차"** 한다. 실측 트레이스(`cursor-jump-evidence/codex-footer-frame.log`):

```
청크 A (footer 프레임): ?2026h … ?25l 지우기×4 ?25h ?2026l   ← 커서는 footer 행에 둔 채 종료
청크 B (~15ms 후):      ?25l [24;3H ?25h                      ← 그리기 없이 hide–move–show: 주차
```

DEC 2026 프레임의 양 끝점은 둘 다 신뢰할 수 없는 스냅샷 시점이다 — post-frame 은 footer 에
주차된 채(청크 A)이고, pre-frame 은 타이핑·composer 행 이동·연속 프레임에서 옛/오염된 위치다.
반면 **프레임 밖에서 온 `?25h`는 앱이 "보이는 커서는 여기"라고 선언하는 가장 권위 있는 신호**다.

구현 규칙:

```typescript
terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
  if (params.includes(25)) {
    if (syncOutputActive) {
      // 프레임 안의 show = 리페인트 꼬리. 위치 신뢰 금지, visibility만 갱신.
      state.isCursorHidden = false;
    } else {
      // ★ 프레임 밖의 show = 커서 주차. 행 일치 게이트 없이 무조건 기록.
      state.cursorX    = buf.cursorX;
      state.cursorAbsY = buf.baseY + buf.cursorY;
      state.parkPending = false;   // 동결 해제
    }
  }
  return false;
});
```

단, **alt buffer 활성 중의 `?25h`도 park 가 아니다** — 전체화면 앱(에디터·페이저)의 좌표는
normal buffer 의 shadow cursor 에 무의미하며, park 로 저장하면 `?1049l` 복귀 후
`hasSyncFramePosition` 이 쓰레기 좌표를 가리킨 채 row-mismatch 게이트가 재동기화를 막아
overlay 가 고착된다. sync frame 안과 마찬가지로 visibility 플래그만 갱신한다.

보조 규칙 2가지:

- **`?2026l` 직후 overlay 동결(`parkPending`)**: at-reset 위치는 폴백 추정치일 뿐이므로 주차가
  도착할 때까지(settle 타임아웃 50ms 한도) overlay 를 마지막으로 그린 위치에 고정한다. 주차를
  안 보내는 TUI 도 최악 50ms 지연으로 수렴 — 커서 블링크 주기보다 짧아 체감 불가.
- **지속적 `?25l` 동안 overlay 캐럿 숨김**: 한 청크 안의 일시적 hide/show 쌍은 rAF coalescing
  으로 화면에 도달하지 않으므로, 화면에 보이는 효과는 앱이 의도한 지속 숨김뿐이다.
  (알려진 한계: park 청크가 PTY 경계에서 `?25l` / CUP `?25h` 로 분할 도착하면 hide 가 1 rAF
  페인트에 도달해 overlay 가 ~16ms 깜빡일 수 있다. 네이티브 터미널과 동일한 수준의 깜빡임이라
  수용한다 — 문제가 되면 hide 쪽에도 짧은 settle 을 주는 대칭 처리가 가능하다.)
  **숨김은 park 동결보다 우선한다** — 프레임이 `?25l` 상태로 끝나면(`?25h` 없이 `?2026l`)
  `parkPending` 동결이 repaint 를 삼키지 않고 숨김이 즉시 화면에 반영되어야 한다. 그렇지
  않으면 직전의 *보이는* overlay 가 settle 윈도 동안 잔존해 앱의 명시적 hide 와 모순된다
  (`shouldFreezeOverlayForPark` 참조).

순수 전이는 `ui/src/lib/shadow-cursor-state.ts`(`applyDectcemShow/Hide`,
`applyParkSettleTimeout`), 트레이스 리플레이 테스트는 `shadow-cursor-state.test.ts` 참조.

---

### 접근 6 — DSR (`CSI 6 n`) 반응적 폴링 — 불필요

xterm.js 버퍼는 `onWriteParsed` 시점에 이미 업데이트되어 있다. `\x1b[6n`을 써서 CPR 응답을 기다리는 것은 불필요한 레이턴시만 추가한다.

---

## 권장 복합 패턴 — 완성 TypeScript 구현

```typescript
import { Terminal, IDisposable, IMarker, IDecoration } from '@xterm/xterm';

interface InputCursorState {
  commandStartLine: number;
  commandStartX: number;
  cursorX: number;
  cursorAbsY: number;
  isInputPhase: boolean;
  isRepaintInProgress: boolean;
}

export class ShadowInputCursor {
  private _s: InputCursorState = {
    commandStartLine: 0, commandStartX: 0,
    cursorX: 0, cursorAbsY: 0,
    isInputPhase: false, isRepaintInProgress: false,
  };
  private _d: IDisposable[] = [];
  private _marker?: IMarker;
  private _decoration?: IDecoration;
  private _pending = false;

  constructor(
    private _t: Terminal,
    private _onChange?: (s: InputCursorState) => void
  ) {
    this._hookOsc();
    this._hookSaveRestore();
    this._hookMode2026();
    this._t.buffer.onBufferChange(buf => {
      if (buf.type === 'alternate') { this._s.isInputPhase = false; this._hide(); }
    });
    this._d.push(this._t.onWriteParsed(() => {
      if (!this._s.isRepaintInProgress) this._schedule();
    }));
  }

  private _hookOsc() {
    const handle = (data: string) => {
      const buf = this._t.buffer.active;
      switch (data.split(';')[0]) {
        case 'A': this._s.isInputPhase = false; break;
        case 'B': // ★ 입력 기준점
          Object.assign(this._s, {
            commandStartX: buf.cursorX,
            commandStartLine: buf.baseY + buf.cursorY,
            cursorX: buf.cursorX,
            cursorAbsY: buf.baseY + buf.cursorY,
            isInputPhase: true,
          });
          this._marker?.dispose();
          this._marker = this._t.registerMarker(0);
          break;
        case 'C': case 'D':
          this._s.isInputPhase = false;
          this._hide();
          break;
      }
      return false;
    };
    this._d.push(
      this._t.parser.registerOscHandler(133, handle),
      this._t.parser.registerOscHandler(633, handle), // VS Code 확장
    );
  }

  private _hookSaveRestore() {
    this._d.push(
      this._t.parser.registerEscHandler({ final: '7' }, () => {
        if (this._s.isInputPhase) this._s.isRepaintInProgress = true;
        return false;
      }),
      this._t.parser.registerEscHandler({ final: '8' }, () => {
        if (this._s.isRepaintInProgress) {
          this._s.isRepaintInProgress = false;
          this._schedule();
        }
        return false;
      }),
      this._t.parser.registerCsiHandler({ final: 's' }, () => {
        if (this._s.isInputPhase) this._s.isRepaintInProgress = true;
        return false;
      }),
      this._t.parser.registerCsiHandler({ final: 'u' }, () => {
        if (this._s.isRepaintInProgress) {
          this._s.isRepaintInProgress = false;
          this._schedule();
        }
        return false;
      }),
    );
  }

  private _hookMode2026() {
    this._d.push(
      this._t.parser.registerCsiHandler({ final: 'l', prefix: '?' }, (params) => {
        if (params.includes(2026)) this._schedule();
        return false;
      })
    );
  }

  private _schedule() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => { this._pending = false; this._sync(); });
  }

  private _sync() {
    if (!this._s.isInputPhase) return;
    if (this._s.isRepaintInProgress) return;
    if (this._t.buffer.active.type === 'alternate') return;

    const buf = this._t.buffer.active;
    this._s.cursorX    = buf.cursorX;
    this._s.cursorAbsY = buf.baseY + buf.cursorY;
    this._show();
    this._onChange?.(this._s);
  }

  private _show() {
    this._decoration?.dispose();
    if (!this._marker || this._marker.isDisposed) return;
    const buf = this._t.buffer.active;
    const delta = this._s.cursorAbsY - (buf.baseY + buf.cursorY);
    this._marker?.dispose();
    this._marker = this._t.registerMarker(delta);
    if (!this._marker) return;

    this._decoration = this._t.registerDecoration({
      marker: this._marker, x: this._s.cursorX, width: 1, height: 1, layer: 'top',
    });
    this._decoration?.onRender(el => {
      el.style.cssText =
        'border-left:2px solid var(--cursor-color,#fff);' +
        'animation:shadow-blink 1s step-end infinite;' +
        'pointer-events:none;z-index:10;';
    });
  }

  private _hide() { this._decoration?.dispose(); this._decoration = undefined; }
  get state(): Readonly<InputCursorState> { return this._s; }
  dispose() { this._hide(); this._marker?.dispose(); this._d.forEach(d => d.dispose()); }
}
```

```css
@keyframes shadow-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
```

---

## 방어 레이어 우선순위

| 순위 | 신호 | 신뢰도 | 필요 조건 |
|------|------|--------|---------|
| 1 | **OSC 133 B 마커** | 최고 | CLI/셸이 시퀀스를 내보내야 함 |
| 2 | **프레임 밖 DECTCEM `?25h` (커서 주차)** | 최고 | TUI가 hide–move–show 주차 패턴 사용 (ratatui/Codex) |
| 3 | **DECRC 이후 커서 위치** | 높음 | CLI가 save/restore 패턴 사용 |
| 4 | **Mode 2026 ESU 이후 커서 (pre-frame 스냅샷 폴백)** | 중간 | CLI가 Mode 2026 사용. 주차가 안 올 때의 settle 폴백 |
| 5 | **onWriteParsed 폴백** | 중간 | 리페인트 미감지 시 최선 추정 |

---

## VS Code vs Warp 비교

**VS Code `PromptInputModel`:** `onCursorMove`·`onData`·`onWriteParsed`를 0ms 마이크로태스크로 조합. OSC 633 B 마커부터 현재 커서까지 버퍼를 읽어 입력 텍스트와 커서 인덱스를 재구성. Ghost text(자동완성 제안)는 셀 SGR 속성 비교로 감지. **위 권장 패턴의 원형.**

**Warp Terminal:** PTY에서 입력을 완전히 분리해 Rust 내장 텍스트 에디터가 입력 버퍼를 직접 관리. 근본적 해결책이지만 지원 셸에서만 동작하며 구현에 수개월이 필요했다.

---

## 결론

**단일 API로는 해결 불가능하다.** 5-레이어 조합이 정답이다.

CLI 저자가 통제권을 가진다면 **OSC 133 시퀀스를 몇 줄만 추가하는 것**이 단연 가장 높은 레버리지다 — 즉시 모든 호환 터미널에서 안정적인 커서 추적이 가능해진다. 터미널 레이어에서만 구현해야 한다면 OSC 133 훅 + **DECTCEM 주차 추적** + DECSC/DECRC 인터셉션 + Mode 2026 + `onWriteParsed` 폴백의 조합이다. OSC 133 을 내보내지 않는 Codex류 TUI 에서는 프레임 밖 DECTCEM 주차가 사실상 1순위 신호가 된다.



