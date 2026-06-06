# Rust + Tauri + xterm.js IDE를 위한 터미널 이스케이프 시퀀스 통합 가이드

Claude Code가 사용하는 모든 OSC/DEC 시퀀스를 **Rust+Tauri+xterm.js 환경에서 파싱하고 연동하는 방법**을 정리한 개발 레퍼런스다. 각 시퀀스의 정확한 바이트 포맷, 공식 스펙 링크, xterm.js API 코드 예제, Tauri/Windows 연동 패턴을 항목별로 제공한다. Claude Code는 현재 **Bracketed Paste(2004), Synchronized Updates(2026), Focus Events(1004)** 를 실제 사용 중이며, OSC 133 시맨틱 프롬프트 지원은 커뮤니티에서 적극 요청 중인 상태다(GitHub issue #22528, #32635).

---

## 1. OSC 8 하이퍼링크

### 시퀀스 포맷

```
열기: \x1b]8;params;URI\x1b\\    (또는 \x1b]8;params;URI\x07)
닫기: \x1b]8;;\x1b\\             (또는 \x1b]8;;\x07)
```

`params`는 `key=value` 쌍을 `:`로 구분한다. 현재 정의된 키는 **`id`** 뿐이며, 동일 `id`+URI를 공유하는 셀은 호버 시 함께 밑줄이 표시된다. URI는 ASCII 32–126 범위만 허용하고, 나머지는 URI 인코딩해야 한다. URI 최대 길이는 **2083바이트**(VTE, iTerm2 기준), `id` 최대 **250바이트**다.

```bash
# 셸 예제
printf '\e]8;;https://example.com\e\\Click here\e]8;;\e\\\n'
printf '\e]8;;file://%s/src/main.rs\e\\main.rs\e]8;;\e\\\n' "$(hostname)"
```

### 공식 스펙

| 문서 | URL |
|------|-----|
| Egmont Koblinger OSC 8 spec | https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda |
| OSC 8 Adoption Tracker | https://github.com/Alhadis/OSC8-Adoption/ |

### xterm.js 구현

xterm.js **5.0.0**부터 OSC 8을 네이티브 지원한다(PR #4005). 점선 밑줄로 렌더링되며, `terminal.options.linkHandler`로 클릭 동작을 커스터마이즈한다.

```typescript
import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

const term = new Terminal();

// OSC 8 링크 핸들러 (file:// 포함 필수: allowNonHttpProtocols)
term.options.linkHandler = {
  activate: (event, uri, range) => {
    const isMac = /Mac/.test(navigator.platform);
    if (!(isMac ? event.metaKey : event.ctrlKey)) return;
    handleLink(uri);
  },
  hover: (event, text) => { /* 툴팁 표시 */ },
  leave: () => { /* 툴팁 제거 */ },
  allowNonHttpProtocols: true  // file:// URI에 필수
};

// 패턴 기반 URL 감지 (web-links 애드온)
term.loadAddon(new WebLinksAddon((event, uri) => handleLink(uri)));

async function handleLink(uri: string) {
  if (uri.startsWith('file://')) {
    const path = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/, ''));
    await invoke('open_file_in_editor', { path });
  } else if (uri.startsWith('http')) {
    await openUrl(uri);
  }
}
```

### Tauri 파일 열기 연동

```rust
// src-tauri/src/lib.rs
#[tauri::command]
fn open_file_in_editor(path: String, line: Option<u32>) -> Result<String, String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("File not found: {}", path));
    }
    std::fs::read_to_string(&path_buf)
        .map_err(|e| format!("Failed to read: {}", e))
}

// Tauri v2 opener 플러그인 사용 시
// cargo add tauri-plugin-opener
// capabilities: ["opener:allow-open-path", "opener:allow-open-url"]
```

| 레퍼런스 | URL |
|----------|-----|
| xterm.js Link Handling Guide | https://xtermjs.org/docs/guides/link-handling/ |
| ILinkHandler API | https://xtermjs.org/docs/api/terminal/interfaces/ilinkhandler/ |
| Tauri Opener Plugin | https://v2.tauri.app/plugin/opener/ |

---

## 2. OSC 9 데스크탑 알림 (ConEmu/iTerm2)

### 시퀀스 포맷과 네임스페이스 충돌

OSC 9는 **iTerm2**와 **ConEmu**가 서로 다른 용도로 사용하는 근본적인 네임스페이스 충돌이 존재한다. iTerm2에서는 `\x1b]9;MESSAGE\x07`이 단순 알림이지만, ConEmu에서는 첫 번째 필드가 서브커맨드 번호로 동작한다.

```
iTerm2 알림:     \x1b]9;메시지텍스트\x07
ConEmu 서브커맨드: \x1b]9;N;파라미터\x07   (N=1~10)
```

**ConEmu 서브커맨드 전체 목록:**

| 시퀀스 | 기능 |
|--------|------|
| `\x1b]9;1;ms\x07` | Sleep ms 밀리초 |
| `\x1b]9;2;"텍스트"\x07` | GUI MessageBox 표시 |
| `\x1b]9;3;"텍스트"\x07` | 탭 제목 변경 |
| `\x1b]9;4;상태;진행률\x07` | **프로그레스 바** (0=제거, 1=진행, 2=에러, 3=미확정, 4=경고) |
| `\x1b]9;9;"경로"\x07` | **현재 작업 디렉터리 보고** (Windows Terminal 채택) |

**OSC 9;4 프로그레스 바**는 Windows Terminal, iTerm2, Ghostty(1.2.0+)가 모두 지원하는 사실상 표준이다. Windows Terminal은 이를 **작업 표시줄 프로그레스**로 표시한다.

### 터미널별 구현 현황

| 터미널 | 알림 지원 | 프로그레스(9;4) | CWD(9;9) |
|--------|-----------|----------------|----------|
| iTerm2 | ✅ (Growl→Notification Center) | ✅ | ❌ |
| ConEmu | ✅ (MessageBox) | ✅ | ✅ |
| Windows Terminal | ❌ (미구현, #7718) | ✅ | ✅ |
| Ghostty | ✅ | ✅ (1.2.0+) | ❌ |

### 공식 문서

| 문서 | URL |
|------|-----|
| ConEmu ANSI Escape Codes | https://conemu.github.io/en/AnsiEscapeCodes.html#ConEmu_specific_OSC |
| iTerm2 Escape Codes | https://iterm2.com/documentation-escape-codes.html |
| Windows Terminal Progress Bar | https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences |
| Windows Terminal 알림 요청 Issue | https://github.com/microsoft/terminal/issues/7718 |

### xterm.js 캡처 + Tauri 알림 변환

```typescript
import { sendNotification, isPermissionGranted, requestPermission }
  from '@tauri-apps/plugin-notification';

// OSC 9 캡처
terminal.parser.registerOscHandler(9, (data: string) => {
  // ConEmu 서브커맨드 vs 순수 알림 구분
  const subCmdMatch = data.match(/^(\d+);/);
  if (subCmdMatch) {
    const subCmd = parseInt(subCmdMatch[1]);
    if (subCmd === 4) handleProgress(data);      // 프로그레스 바
    else if (subCmd === 9) handleCwdChange(data); // CWD 변경
    return true;
  }
  // 순수 iTerm2 스타일 알림
  sendTauriNotification('Terminal', data);
  return true;
});

async function sendTauriNotification(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (granted) sendNotification({ title, body });
}
```

### WSL → Windows 알림 브릿징

Windows Terminal은 현재 OSC 9 알림을 Windows 토스트로 변환하지 **않는다**(issue #7718). 다만 **OSC 777을 통한 토스트 알림은 PR #14425로 구현**되었다. WSL에서 Windows 알림을 보내는 대안:

- **`wsl-notify-send`**: `notify-send` 대체 도구로 Windows Toast API 직접 호출 (https://github.com/stuartleeks/wsl-notify-send)
- **Tauri 앱 자체 처리**: PTY 출력에서 OSC 9를 파싱하여 `tauri-plugin-notification`으로 변환 (위 코드 참고)
- **`winrt-notification` 크레이트**: Rust에서 직접 WinRT Toast 생성

```rust
// Rust 네이티브 Windows 알림 (tauri-plugin-notification 대신 직접 사용 시)
use winrt_notification::{Toast, Sound, Duration};

Toast::new(Toast::POWERSHELL_APP_ID)
    .title("Build Complete")
    .text1("컴파일이 완료되었습니다")
    .sound(Some(Sound::SMS))
    .duration(Duration::Short)
    .show()
    .expect("toast failed");
```

---

## 3. OSC 777 데스크탑 알림 (rxvt-unicode)

### 시퀀스 포맷

```
\x1b]777;notify;TITLE;BODY\x07       (BEL 종료)
\x1b]777;notify;TITLE;BODY\x1b\\     (ST 종료)
```

`notify`는 OSC 777의 서브커맨드 중 하나다. rxvt-unicode(urxvt)에서 **OSC 777은 Perl 확장 디스패치 메커니즘**으로 설계되었으며, `notify`는 알림용 확장이다. 공식 스펙은 없고, Fedora의 VTE 패치가 `OSC 777;notify`를 GNOME Terminal에 도입하면서 사실상 표준이 되었다.

### 터미널 지원 현황

| 터미널 | 지원 | 비고 |
|--------|------|------|
| rxvt-unicode | ✅ | 원조 (Perl 확장) |
| Ghostty | ✅ | `desktop-notifications = true` |
| WezTerm | ✅ | 빌트인 |
| foot (Wayland) | ✅ | OSC 9 충돌 때문에 777만 지원 |
| VTE 기반 (GNOME Terminal) | ✅ | Fedora 패치 |
| **Windows Terminal** | **✅** | **PR #14425 구현 완료** |
| Kitty | ❌ | 자체 OSC 99 프로토콜 사용 |
| VSCode | ❌ | 확장 필요 (Terminal Notification 확장) |

### 공식 문서

| 문서 | URL |
|------|-----|
| urxvtperl(3) man page | https://manpages.debian.org/testing/rxvt-unicode/urxvtperl.3.en.html |
| rxvt-unicode 공식 사이트 | https://software.schmorp.de/pkg/rxvt-unicode.html |
| Windows Terminal 구현 PR | https://github.com/microsoft/terminal/pull/14425 |
| terminal-wg 표준화 논의 | https://gitlab.freedesktop.org/terminal-wg/specifications/-/issues/13 |

### VSCode 통합 터미널 처리 방식

VSCode는 OSC 777을 네이티브로 처리하지 **않는다**. **Terminal Notification** 확장(https://marketplace.visualstudio.com/items?itemName=wenbopan.vscode-terminal-osc-notifier)을 설치해야 OSC 9/777을 OS 알림으로 변환한다. VSCode 내부에서는 xterm.js의 `Terminal` 객체 파서에 직접 접근할 수 없으므로, 이 확장은 터미널 데이터 스트림을 모니터링하여 OSC 시퀀스를 감지한다.

---

## 4. OSC 133 시맨틱 프롬프트 존 (FTCS)

### 시퀀스 포맷

FinalTerm Command Sequences(FTCS)는 셸 프롬프트, 사용자 입력, 명령 출력 영역을 의미론적으로 구분한다.

| 시퀀스 | 이름 | 의미 | 발생 시점 |
|--------|------|------|-----------|
| `\x1b]133;A\x07` | FTCS_PROMPT | 프롬프트 시작 | 프롬프트 첫 글자 직전 |
| `\x1b]133;B\x07` | FTCS_COMMAND_START | 입력 시작 | 프롬프트 마지막 글자 직후, 사용자 입력 시작 |
| `\x1b]133;C\x07` | FTCS_COMMAND_EXECUTED | 출력 시작 | Enter 입력 후, 명령 출력 시작 전 |
| `\x1b]133;D;{exitcode}\x07` | FTCS_COMMAND_FINISHED | 출력 종료 | 명령 출력 완료 후 (exitcode: 0=성공, 非0=실패) |

**확장 파라미터(Per Bothner 스펙 / Ghostty):**

- `\x1b]133;A;cl=m;aid=12345\x07` — 멀티라인 클릭 이동 모드, 프로세스 ID 전달
- `\x1b]133;A;cl=line\x07` — 싱글라인 클릭→커서 이동 (Ghostty 1.3+)
- `\x1b]133;P;k=i\x07` — 1차 프롬프트(PS1) 시작 (fresh-line 없음)
- `\x1b]133;P;k=s\x07` — 2차 프롬프트(PS2, continuation) 시작

**명령 생명주기:**

```
\x1b]133;D;0\x07          ← 이전 명령 종료 (exit code 0)
\x1b]133;A\x07            ← 프롬프트 시작
  $ git status            ← 프롬프트 텍스트
\x1b]133;B\x07            ← 사용자 입력 시작
  ls -la                  ← 사용자가 타이핑
\x1b]133;C\x07            ← Enter 후, 출력 시작
  total 42                ← 명령 출력
  drwxr-xr-x ...
\x1b]133;D;0\x07          ← 명령 종료 (성공)
\x1b]133;A\x07            ← 다음 프롬프트 시작
```

### 공식 스펙 문서

| 문서 | URL |
|------|-----|
| **Per Bothner Semantic Prompts** (정규 스펙) | https://gitlab.freedesktop.org/Per_Bothner/specifications/-/blob/master/proposals/semantic-prompts.md |
| iTerm2 Shell Integration | https://iterm2.com/documentation-escape-codes.html |
| iTerm2 Protocol 상세 Gist | https://gist.github.com/tep/e3f3d384de40dbda932577c7da576ec3 |
| Contour Terminal OSC 133 | https://contour-terminal.org/vt-extensions/osc-133-shell-integration/ |
| VSCode Shell Integration | https://code.visualstudio.com/docs/terminal/shell-integration |
| Windows Terminal Shell Integration | https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration |

### 터미널 구현 참고

**Ghostty**: 현재 행 기반(row-based) 마킹을 사용하며, 영역 기반(region-based)으로 마이그레이션 예정(issue #5932). Jump-to-prompt는 Ctrl+Shift+J/K. 셸 통합 스크립트는 `src/shell-integration/` 디렉터리에 Bash/Zsh/Fish/Elvish/Nushell 5종 제공.

**WezTerm**: `SemanticZone` 개념으로 영역을 모델링. `ScrollToPrompt(-1/1)`으로 프롬프트 점프, 트리플 클릭으로 명령 출력 전체 선택 가능. 셸 통합: https://wezterm.org/shell-integration.html

**VSCode**: `ShellIntegrationAddon`이 OSC 133(FinalTerm)과 OSC 633(VSCode 전용 확장)을 모두 처리. 633은 E(명령줄 텍스트), P(속성), nonce 검증을 추가 제공.

**Windows Terminal**: OSC 133 전체 지원. 스크롤바 마크, 프롬프트 네비게이션, exit code 기반 색상 표시.

### xterm.js 구현 — ShellIntegrationAddon

```typescript
import { Terminal, ITerminalAddon, IDisposable, IMarker } from '@xterm/xterm';

interface CommandEntry {
  promptStart: IMarker;
  inputStart?: IMarker;
  outputStart?: IMarker;
  outputEnd?: IMarker;
  command?: string;
  exitCode?: number;
}

export class ShellIntegrationAddon implements ITerminalAddon {
  private _terminal?: Terminal;
  private _disposables: IDisposable[] = [];
  private _commands: CommandEntry[] = [];
  private _current: Partial<CommandEntry> = {};

  // 외부에서 프롬프트 점프, 출력 선택 등에 접근
  get commands(): ReadonlyArray<CommandEntry> { return this._commands; }

  activate(terminal: Terminal): void {
    this._terminal = terminal;
    this._disposables.push(
      terminal.parser.registerOscHandler(133, data => this._handle(data))
    );
  }

  private _handle(data: string): boolean {
    const [cmd, ...params] = data.split(';');
    const t = this._terminal!;

    switch (cmd) {
      case 'A': { // Prompt Start
        const marker = t.registerMarker(0);
        if (marker) this._current = { promptStart: marker };
        return true;
      }
      case 'B': { // Command Start (사용자 입력 시작)
        const marker = t.registerMarker(0);
        if (marker) this._current.inputStart = marker;
        return true;
      }
      case 'C': { // Command Executed (출력 시작)
        const marker = t.registerMarker(0);
        if (marker) {
          this._current.outputStart = marker;
          // B~C 사이 텍스트 = 사용자가 입력한 명령
          if (this._current.inputStart) {
            this._current.command = this._extractText(
              this._current.inputStart, marker
            );
          }
        }
        return true;
      }
      case 'D': { // Command Finished
        const marker = t.registerMarker(0);
        if (marker) {
          this._current.outputEnd = marker;
          if (params[0] !== '') {
            this._current.exitCode = parseInt(params[0], 10);
          }
          if (this._current.promptStart) {
            this._commands.push(this._current as CommandEntry);
          }
          this._current = {};
        }
        return true;
      }
    }
    return false;
  }

  /** 프롬프트 점프: direction -1=이전, 1=다음 */
  scrollToPrompt(direction: -1 | 1): void {
    const t = this._terminal!;
    const viewportY = t.buffer.active.viewportY;
    if (direction === -1) {
      for (let i = this._commands.length - 1; i >= 0; i--) {
        if (this._commands[i].promptStart.line < viewportY) {
          t.scrollToLine(this._commands[i].promptStart.line);
          return;
        }
      }
    } else {
      for (const cmd of this._commands) {
        if (cmd.promptStart.line > viewportY) {
          t.scrollToLine(cmd.promptStart.line);
          return;
        }
      }
    }
  }

  /** 명령 출력 텍스트 추출 */
  getCommandOutput(index: number): string {
    const cmd = this._commands[index];
    if (!cmd?.outputStart || !cmd?.outputEnd) return '';
    return this._extractText(cmd.outputStart, cmd.outputEnd);
  }

  private _extractText(start: IMarker, end: IMarker): string {
    const buf = this._terminal!.buffer.active;
    let text = '';
    for (let i = start.line; i <= end.line; i++) {
      const line = buf.getLine(i);
      if (line) text += line.translateToString(true) + '\n';
    }
    return text.trim();
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}
```

### Claude Code GitHub Issues

**Issue #22528** (2026-02-02, @devenv): Claude Code가 REPL 프롬프트 주변에 OSC 133을 emit하여 터미널에서 프롬프트 점프를 지원해달라는 요청. #32635의 중복으로 닫힘.

**Issue #32635** (2026-03-09, @s-b-e-n-s-o-n): 상세 제안서로, 다음 시퀀스 추가를 요청:
- 프롬프트 렌더 전 `\x1b]133;A;cl=line\x07`
- 사용자 입력 전 `\x1b]133;B\x07`
- 명령 제출 시 `\x1b]133;C\x07`
- 출력 완료 후 `\x1b]133;D\x07`

이슈에서 "Claude Code는 이미 **mode 2004(bracketed paste), mode 2026(synchronized updates), mode 1004(focus events)** 를 사용하므로, OSC 133도 동일한 패턴으로 추가 가능"하다고 언급했다. `cl=line` 파라미터는 Ghostty 1.3+에서 마우스 클릭을 좌/우 화살표 키로 변환하는 기능이다.

---

## 5. DEC Private Mode 시퀀스

Claude Code가 실제 사용 중인 세 가지 DEC 프라이빗 모드의 완전한 레퍼런스다.

### DEC 2004 — Bracketed Paste Mode

```
활성화:    \x1b[?2004h     (DECSET)
비활성화:  \x1b[?2004l     (DECRST)
붙여넣기:  \x1b[200~{내용}\x1b[201~   (터미널이 감쌈)
```

애플리케이션이 `?2004h`를 보내면, 터미널은 클립보드 붙여넣기를 `\x1b[200~`와 `\x1b[201~`로 감싸서 stdin으로 전달한다. 이로써 프로그램이 타이핑과 붙여넣기를 구분할 수 있다. **xterm.js는 네이티브로 완전 지원**(~2017, PR #1097). `InputHandler.ts`에서 DECSET case 2004를 처리하며, 브라우저 클립보드 paste 이벤트 시 자동으로 래핑한다.

| 문서 | URL |
|------|-----|
| Terminal Guide | https://terminalguide.namepad.de/mode/p2004/ |
| Bracketed Paste 블로그 | https://cirw.in/blog/bracketed-paste |
| xterm.js PR #1097 | https://github.com/xtermjs/xterm.js/pull/1097 |

### DEC 2026 — Synchronized Output (동기화 렌더링)

```
동기화 시작 (BSU): \x1b[?2026h
동기화 끝 (ESU):   \x1b[?2026l
모드 쿼리 (DECRQM): \x1b[?2026$p
```

BSU를 보내면 터미널은 화면 렌더링을 보류하고, ESU에서 모든 변경을 **원자적으로 한 번에 렌더링**한다. 빠른 업데이트 시 화면 찢어짐(tearing)을 방지한다. 안전 타임아웃은 **1초**로, ESU가 오지 않으면 자동 플러시된다.

**xterm.js 6.0.0에서 지원 추가**(2025년 12월 머지, PR #5453). Claude Code 팀의 @chrislloyd가 구현하고 @Tyriar가 리뷰했다. `terminal.modes.synchronizedOutputMode`로 상태 접근 가능.

| 문서 | URL |
|------|-----|
| **정규 스펙 (contour-terminal)** | https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md |
| Contour 문서 | https://contour-terminal.org/vt-extensions/synchronized-output/ |
| xterm.js PR #5453 | https://github.com/xtermjs/xterm.js/pull/5453 |
| xterm.js Issue #3375 | https://github.com/xtermjs/xterm.js/issues/3375 |

### DEC 1004 — Focus Events Mode

```
활성화:    \x1b[?1004h
비활성화:  \x1b[?1004l
포커스 획득: \x1b[I    (터미널 → 앱)
포커스 상실: \x1b[O    (터미널 → 앱)
```

활성화되면 터미널 창이 포커스를 얻거나 잃을 때 `\x1b[I` / `\x1b[O`를 stdin으로 전송한다. Claude Code는 이를 활용해 compact/dashboard 뷰를 전환한다. **xterm.js 빌트인 지원** — 브라우저의 focus/blur 이벤트를 감지하여 자동으로 시퀀스를 생성한다.

**Tauri 윈도우 포커스 브릿지:**

```typescript
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();
appWindow.onFocusChanged(({ payload: focused }) => {
  if (focused) terminal.focus();  // xterm.js가 mode 1004 활성 시 \x1b[I 전송
  else terminal.blur();           // \x1b[O 전송
});
```

### xterm.js 지원 상태 요약

| 기능 | 모드 | xterm.js | 버전 |
|------|------|----------|------|
| Bracketed Paste | DEC 2004 | ✅ 네이티브 | ~v3.x (2017) |
| Synchronized Output | DEC 2026 | ✅ 네이티브 | v6.0.0 (2025.12) |
| Focus Events | DEC 1004 | ✅ 네이티브 | 빌트인 |

---

## 6. xterm.js OSC 파서 API 종합

### IParser 인터페이스

`terminal.parser`를 통해 접근하며, 네 가지 핸들러 등록 메서드를 제공한다.

```typescript
interface IParser {
  registerOscHandler(ident: number,
    callback: (data: string) => boolean | Promise<boolean>): IDisposable;
  registerCsiHandler(id: IFunctionIdentifier,
    callback: (params: (number | number[])[]) => boolean | Promise<boolean>): IDisposable;
  registerDcsHandler(id: IFunctionIdentifier,
    callback: (data: string, param: (number | number[])[]) => boolean | Promise<boolean>): IDisposable;
  registerEscHandler(id: IFunctionIdentifier,
    handler: () => boolean | Promise<boolean>): IDisposable;
}

interface IFunctionIdentifier {
  prefix?: string;        // '?' for DEC private modes
  intermediates?: string;  // '$', "'" 등
  final: string;          // 'h', 'l', 'm', 'H' 등
}
```

**핵심 동작**: 핸들러는 **역순으로 탐색**(마지막 등록 = 최우선). `true` 반환 시 전파 중단, `false` 시 이전 핸들러로 전달. OSC/DCS 페이로드 최대 **10MB**. 비동기 핸들러는 파서를 블로킹하므로 최소화할 것.

### xterm.js 빌트인 OSC 핸들러 목록

`InputHandler.ts`에서 기본 등록되는 OSC 코드. 이 목록에 없는 코드는 **커스텀 등록이 필요**하다.

| OSC 코드 | 기능 | 커스텀 등록 필요 여부 |
|----------|------|---------------------|
| 0 | 윈도우 제목 + 아이콘 설정 | ❌ 빌트인 |
| 1 | 아이콘 이름 설정 | ❌ 빌트인 |
| 2 | 윈도우 제목 설정 | ❌ 빌트인 |
| 4 | ANSI 색상 변경 | ❌ 빌트인 |
| **8** | **하이퍼링크** | ❌ 빌트인 (v5.0+) |
| 10 | 전경색 설정/쿼리 | ❌ 빌트인 |
| 11 | 배경색 설정/쿼리 | ❌ 빌트인 |
| 12 | 커서색 설정/쿼리 | ❌ 빌트인 |
| 104/110/111/112 | 색상 리셋 | ❌ 빌트인 |
| **9** | **알림/ConEmu** | ✅ 커스텀 필요 |
| **133** | **시맨틱 프롬프트** | ✅ 커스텀 필요 |
| **633** | **VSCode 셸 통합** | ✅ 커스텀 필요 |
| **777** | **rxvt-unicode 알림** | ✅ 커스텀 필요 |

### 통합 애드온 패턴 — ClaudeCodeAddon

모든 커스텀 OSC/CSI 핸들러를 하나의 애드온으로 묶는 권장 패턴:

```typescript
import { Terminal, ITerminalAddon, IDisposable } from '@xterm/xterm';

export class ClaudeCodeAddon implements ITerminalAddon {
  private _disposables: IDisposable[] = [];
  private _shellIntegration: ShellIntegrationAddon;

  constructor(
    private _onNotification: (title: string, body: string) => void,
    private _onCwdChange: (path: string) => void,
    private _onProgress: (state: number, value: number) => void,
  ) {
    this._shellIntegration = new ShellIntegrationAddon();
  }

  activate(terminal: Terminal): void {
    // 시맨틱 프롬프트 (OSC 133)
    this._shellIntegration.activate(terminal);

    // 알림 (OSC 9 — iTerm2 스타일)
    this._disposables.push(
      terminal.parser.registerOscHandler(9, data => {
        const sub = data.match(/^(\d+);(.*)/s);
        if (sub) {
          if (sub[1] === '4') {
            const [, state, progress] = sub[2].split(';');
            this._onProgress(parseInt(state), parseInt(progress || '0'));
            return true;
          }
          if (sub[1] === '9') {
            this._onCwdChange(sub[2].replace(/^"(.*)"$/, '$1'));
            return true;
          }
        }
        this._onNotification('Terminal', data);
        return true;
      })
    );

    // 알림 (OSC 777 — rxvt-unicode 스타일)
    this._disposables.push(
      terminal.parser.registerOscHandler(777, data => {
        const parts = data.split(';');
        if (parts[0] === 'notify') {
          const title = parts[1] || 'Notification';
          const body = parts.slice(2).join(';');
          this._onNotification(title, body);
          return true;
        }
        return false;
      })
    );

    // CWD 변경 (OSC 7)
    this._disposables.push(
      terminal.parser.registerOscHandler(7, data => {
        // data = "file:///path/to/dir"
        this._onCwdChange(data.replace(/^file:\/\/[^/]*/, ''));
        return false; // 기본 핸들러도 실행
      })
    );
  }

  get shellIntegration() { return this._shellIntegration; }

  dispose(): void {
    this._shellIntegration.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

// 사용 예:
const addon = new ClaudeCodeAddon(
  (title, body) => sendTauriNotification(title, body),
  (path) => updateExplorerCwd(path),
  (state, value) => updateProgressBar(state, value),
);
terminal.loadAddon(addon);
```

### xterm-addon-web-links의 OSC 8 처리 방식

`@xterm/addon-web-links`는 `registerOscHandler`를 사용하지 **않는다**. OSC 8은 xterm.js 코어의 `InputHandler.ts`에서 `setHyperlink()`으로 네이티브 처리된다. web-links 애드온은 **패턴 기반 URL 감지**(정규식으로 버퍼 텍스트 스캔)만 담당하며, `ILinkProvider` 인터페이스를 통해 xterm.js에 등록된다.

### API 문서 링크

| 문서 | URL |
|------|-----|
| IParser API | https://xtermjs.org/docs/api/terminal/interfaces/iparser/ |
| Parser Hooks Guide | https://xtermjs.org/docs/guides/hooks/ |
| Using Addons Guide | https://xtermjs.org/docs/guides/using-addons/ |
| VT Features 전체 목록 | https://xtermjs.org/docs/api/vtfeatures/ |
| Terminal Class API | https://xtermjs.org/docs/api/terminal/classes/terminal/ |
| InputHandler.ts 소스 | https://github.com/xtermjs/xterm.js/blob/master/src/common/InputHandler.ts |

---

## 7. WSL 환경 특이사항

### WSL → Windows 출력 파이프라인

WSL 프로세스의 터미널 출력은 **ConPTY를 경유**하며, 이 과정에서 이스케이프 시퀀스가 **투명하게 전달되지 않는다**.

```
WSL Linux 프로세스 (bash/zsh)
  └─▶ Linux PTY (/dev/pts/N)
       └─▶ WSL 변환 계층 / wsl.exe
            └─▶ ConPTY (Pseudo Console API)
                 ├─▶ VT 파서 (내부 상태 머신)
                 ├─▶ 내부 터미널 그리드 (버퍼 유지)
                 ├─▶ VT 렌더러 (상태를 VT로 재직렬화)
                 └─▶ 출력 파이프 → Tauri 앱 / xterm.js
```

ConPTY는 단순 파이프가 **아니다**. **파싱→상태변환→재직렬화** 파이프라인이다. 원본 셸 출력을 파싱하여 내부 그리드 상태를 변경한 뒤, 다시 VT 시퀀스로 재생성한다. 이 때문에 다음 문제가 발생한다:

### ConPTY의 알려진 제약사항

- **DCS 시퀀스가 삼켜진다**: 인식하지 못하는 Device Control Strings는 포워딩되지 않음 (issue #17313)
- **OSC 시퀀스 순서가 뒤섞인다**: OSC가 주변 텍스트 대비 원래 위치에서 벗어나 도착함 (issue #17314)
- **커서 이동 시퀀스 주입**: ConPTY가 자체 `CSI ... H` 시퀀스를 삽입하여 커서 드리프트 발생
- **입력 시퀀스 변형**: 일부 CSI 입력 시퀀스가 수정됨 (issue #12166)
- **재직렬화 손실**: 파싱 파이프라인을 거치므로 인식 못하는 시퀀스는 유실 가능

**중요**: OSC 9, OSC 133, OSC 777 등 표준 OSC 시퀀스는 ConPTY를 통과하지만, **도착 순서가 텍스트와 어긋날 수 있다**. 셸 통합 마커 위치가 미세하게 어긋나는 원인이 된다.

### ConPTY 우회 방법

Terminal++가 구현한 **ConPTY 바이패스**: WSL 내부에 작은 Linux 바이너리(`tpp-bypass`)를 두어 네이티브 Linux PTY를 열고, stdin/stdout으로 I/O를 브릿지한다. ConPTY를 완전히 우회하여 원본 ANSI 시퀀스를 그대로 받는다. cmd/PowerShell에는 사용 불가.

### Tauri + xterm.js + WSL PTY 통합

**권장 크레이트:**

| 크레이트 | 특징 | URL |
|---------|------|-----|
| `portable-pty` | WezTerm 기반, 가장 성숙. ConPTY/Unix PTY 자동 선택 | https://crates.io/crates/portable-pty |
| `tauri-plugin-pty` | Tauri v2 전용 플러그인, 가장 간단한 통합 | https://github.com/Tnze/tauri-plugin-pty |
| `winpty-rs` | ConPTY/WinPTY 백엔드 명시적 선택 가능 | https://github.com/andfoy/winpty-rs |

**핵심 코드 패턴 (portable-pty + Tauri):**

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
use std::io::Read;

#[tauri::command]
fn spawn_wsl(app: tauri::AppHandle) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("wsl.exe");
    cmd.args(["-d", "Ubuntu", "--", "bash", "-l"]);
    cmd.env("TERM", "xterm-256color");

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // 비동기 리더 스레드
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // UTF-8 경계 처리 주의!
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = handle.emit("pty-output", &data);
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}
```

```typescript
// 프론트엔드: Tauri 이벤트 → xterm.js 연결
import { listen } from '@tauri-apps/api/event';

listen<string>('pty-output', (event) => {
  terminal.write(event.payload);
});

terminal.onData((data) => {
  invoke('write_to_pty', { input: data });
});
```

### 주의사항

- **UTF-8 경계**: PTY 읽기에서 멀티바이트 문자가 버퍼 경계에서 잘릴 수 있다. 링 버퍼를 사용하여 완전한 UTF-8 시퀀스만 변환할 것.
- **리사이즈 전파**: xterm.js 리사이즈 시 `master.resize(PtySize { rows, cols, .. })`를 반드시 호출. ConPTY가 WSL 프로세스에 SIGWINCH를 전파한다.
- **바이너리 데이터**: Tauri 이벤트 시스템에서 JSON 직렬화 문제를 피하려면 base64 인코딩을 고려하거나 IPC 채널로 raw 바이너리를 전송할 것.
- **ConPTY 시작 지연**: `CreatePseudoConsole()`이 `CSI 6n`(커서 위치 리포트)을 보내고 응답을 기다린다. xterm.js 측에서 이를 처리해야 hangup이 발생하지 않는다.

### Windows Terminal 소스 참고

| 파일 | 역할 | URL |
|------|------|-----|
| stateMachine.cpp | VT 상태 머신 (토크나이저) | https://github.com/microsoft/terminal/blob/main/src/terminal/parser/stateMachine.cpp |
| OutputStateMachineEngine.cpp | OSC 디스패치 | https://github.com/microsoft/terminal/blob/main/src/terminal/parser/OutputStateMachineEngine.cpp |
| adaptDispatch.cpp | 시퀀스 실행 계층 | https://github.com/microsoft/terminal/blob/main/src/terminal/adapter/adaptDispatch.cpp |
| DispatchTypes.hpp | OscActionCodes 열거형 | https://github.com/microsoft/terminal/blob/main/src/terminal/adapter/DispatchTypes.hpp |
| ConPTY 소스 | 의사 콘솔 구현 | https://github.com/microsoft/terminal/tree/main/src/winconpty |
| OSC 777 알림 PR | 토스트 알림 구현 | https://github.com/microsoft/terminal/pull/14425 |

---

## Conclusion

이 가이드에서 다룬 시퀀스들은 크게 세 가지 범주로 나뉜다. **이미 xterm.js가 네이티브 처리하는 것**(OSC 8, DEC 2004/2026/1004)은 별도 파싱 없이 동작하며, `linkHandler`나 Tauri 포커스 이벤트 브릿지 정도만 연결하면 된다. **커스텀 등록이 필요한 것**(OSC 9, OSC 133, OSC 777)은 `registerOscHandler`로 파싱한 뒤 Tauri 플러그인(notification, opener)과 연동해야 한다. **WSL 환경**에서는 ConPTY의 재직렬화 파이프라인 때문에 OSC 시퀀스 순서 어긋남에 주의해야 하며, 정밀한 시퀀스 전달이 필요하면 ConPTY 바이패스를 고려할 수 있다.

가장 영향력이 큰 구현 우선순위는: **OSC 133 셸 통합**(프롬프트 점프와 출력 선택으로 Claude Code 세션 탐색성을 획기적으로 개선) → **OSC 9/777 알림**(장시간 작업 완료 알림) → **OSC 8 파일 링크**(에러 메시지에서 파일 직접 열기) 순서다. 위에 제시한 `ClaudeCodeAddon` 패턴으로 모든 커스텀 핸들러를 하나의 xterm.js 애드온에 통합하면, 유지보수와 테스트가 용이한 깨끗한 아키텍처를 유지할 수 있다.