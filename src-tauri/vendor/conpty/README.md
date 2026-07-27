# Vendored ConPTY runtime

Windows 용 ConPTY 재배포본(`conpty.dll` + `OpenConsole.exe`)이다. 왜 in-box
conhost 를 안 쓰는지는 [ADR-0066](../../../docs/adr/0066-bundled-conpty-runtime.md) 에 있다.
요약: in-box conhost 는 자식이 보낸 `OSC 10/11` 색상 질의를 소비하고 응답하지
않아 WSL 안의 앱이 터미널 색을 알아낼 방법이 없다 (issue #580).

## 현재 버전

`1.23.251008001`

## 출처

Microsoft 가 `Microsoft.Windows.Console.ConPTY` 로 배포하는 바이너리이며,
[Windows Terminal](https://github.com/microsoft/terminal)(MIT) 의 OpenConsole
빌드다. 여기 들어 있는 사본은 npm `node-pty@1.1.0` 의
`third_party/conpty/<version>/` 에서 가져왔다 — VS Code 가 쓰는 것과 같은
바이너리다.

## 갱신 방법

```bash
npm pack node-pty@<version>
tar xzf node-pty-<version>.tgz 'package/third_party/conpty/*'
# 새 버전 디렉터리로 통째로 복사한 뒤 옛 버전 디렉터리를 지운다
```

옮긴 뒤 `src-tauri/src/conpty_runtime.rs` 의 `CONPTY_RUNTIME_VERSION` 을 같은
값으로 맞춘다. `cargo test conpty_runtime` 이 벤더 트리와 상수의 불일치,
잘린 사본, PE 헤더가 아닌 파일을 잡는다.

버전을 올리면 ConPTY 의 리사이즈 repaint 거동이 함께 바뀔 수 있다.
[ADR-0026](../../../docs/adr/0026-conpty-width-resize-repaint-filter.md) 의 전제를
실기로 다시 확인한다.

## 배치

`build.rs` 가 타깃 아키텍처에 맞는 쌍을 두 곳에 복사한다.

- `target/<profile>/` — `cargo run` / `cargo tauri dev` 가 쓰는 실행 파일 옆
- `src-tauri/gen/conpty/` — `tauri.windows.conf.json` 의 resources 가 설치본
  exe 옆으로 옮기는 스테이징 (gitignore 대상)

`portable-pty` 는 `LoadLibrary("conpty.dll")` 로 실행 파일 디렉터리를 먼저
찾으므로, 이 배치만으로 사이드로드가 성립한다. 파일이 없으면 조용히 kernel32
(in-box conhost)로 폴백한다.
