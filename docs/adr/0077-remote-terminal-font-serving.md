# 0077. Remote 터미널 폰트는 데스크톱 시스템 폰트를 sfnt 그대로 서빙한다

- Status: Proposed
- Date: 2026-07-28
- Source: 사용자 요구("모바일에서도 PC 터미널 폰트를 쓰고 싶다"), [api-contracts.md](../architecture/api-contracts.md) Remote 계약, [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)(네트워크 노출 정책)

## Context

Remote 페이지(`/remote/`)는 데스크톱 프로필의 터미널 폰트를 **이름만** 전달한다. 서버는 `'<face>', 'Cascadia Mono', 'Consolas', monospace` 형태의 CSS 폰트 스택 문자열을 만들고, 모바일 브라우저의 xterm 이 그 이름으로 로컬 설치 폰트를 찾는다. 모바일 기기에는 Cascadia Mono 도 Consolas 도 없으므로 실제로는 거의 항상 시스템 `monospace` 로 렌더된다.

이건 미관 문제만이 아니다. Remote 는 `fit` 애드온으로 셀 크기를 재서 열 수를 정하고, 그 열 수는 PTY 의 전역 상태가 된다([ADR-0015](0015-remote-terminal-state-ownership.md), [ADR-0038](0038-remote-height-shrink-surface-crop.md)). 데스크톱과 모바일의 글리프 advance 비율이 다르면 같은 화면 폭에서 서로 다른 열 수가 나오고, TUI 정렬·박스 문자·CJK 반각/전각 폭 판정이 어긋난다. 폭 판정 자체는 [ADR-0058](0058-single-terminal-cell-width-provider.md)의 공용 width provider 를 Remote 에도 주입해 맞췄지만, 실제 렌더 폰트가 다르면 그 계산과 픽셀이 따로 논다.

결정이 필요한 force:

- **라이선스** — 시스템 폰트 바이너리를 네트워크로 내보내는 것은 재배포다. Cascadia Code/D2Coding/JetBrains Mono 는 OFL 이라 문제없지만 Consolas 같은 OS 번들 독점 폰트는 재배포가 허용되지 않는다. Remote 는 LAN 직결뿐 아니라 클라우드 relay 경유도 지원하므로 "내 기기 안"으로 볼 수 없는 경로가 있다.
- **용량** — Nerd Font 패치본·CJK 포함 monospace 는 2 MB 를 쉽게 넘는다. bold/italic 까지 4 페이스면 그 4 배다. 모바일 회선으로 매번 받는 건 곤란하다.
- **빌드 비용** — woff2 인코더는 순수 Rust 구현이 사실상 없다. `woff2` 크레이트는 google/woff2 C++ FFI 라 cmake + C++ 툴체인이 빌드에 붙는다.
- **xterm 의 계측 시점** — xterm `OptionsService` 는 값이 실제로 바뀔 때만 `onOptionChange` 를 쏜다. 같은 `fontFamily` 문자열을 다시 넣으면 셀 크기 재계측이 일어나지 않는다. 폰트가 늦게 도착하면 잘못된 셀 크기가 그대로 남는다.

비목표: 데스크톱 UI 폰트(터미널 외 chrome) 전송, 서브셋팅, 폰트 업로드/동기화 기능, 사용자가 임의 폰트 파일을 지정하는 경로.

## Decision

**Remote 터미널 폰트는 데스크톱이 시스템에서 해석한 sfnt(ttf/otf) 바이트를 그대로 서빙하고, 전송 압축은 HTTP `Content-Encoding: br` 로 처리한다. woff2 컨테이너 변환은 하지 않는다.** 기능은 `remote.serveTerminalFont` 토글로 게이트하며 기본값은 off 다.

구체적으로:

1. **SoT 와 소유권.** 어떤 폰트를 서빙할지는 데스크톱 설정(프로필 폰트 face)이 단독 소유한다. Remote 클라이언트는 폰트를 고르지 않고, 받은 것을 쓰거나 폴백한다. 폰트 해석·검증·캐시는 `remote_server::font_assets` 한 모듈이 소유한다.
2. **외부 계약.** 터미널 appearance 페이로드에 `fontAssets` 를 선택적으로 싣는다. `{ family, faces: [{ url, weight, style }] }` 형태이고, 서빙 불가·비활성일 때는 필드 자체를 생략한다. `family` 는 `LxRemoteFont-<token>` 형태의 **별칭**이며 실제 face 이름이 아니다 — 로컬 동명 폰트와 충돌하지 않게 하고, 로드 완료 시점에 `fontFamily` 문자열이 실제로 달라지도록 만들기 위해서다.
3. **URL 은 콘텐츠 해시.** `/remote/font/{token}.{ttf|otf}`, `token` = sha256(폰트 바이트) 앞 16 자리 hex. 내용이 바뀌면 URL 이 바뀌므로 `Cache-Control: public, max-age=31536000, immutable` 을 안전하게 붙인다. 라우트는 기존 `remote_asset` 과 같은 게이트(터널이면 enable 체크, 직결이면 토큰/IP/Origin 전체 검사)를 받는다.
4. **서빙 거부 조건.** 다음 중 하나면 그 face 를 광고하지 않고 기존 이름-only 동작으로 폴백한다 — 토글 off, 시스템에서 face 해석 실패, `ttcf`(폰트 컬렉션: 브라우저 `@font-face` 미지원), 페이스당 8 MiB 초과, sfnt 매직 불일치.
5. **페이스 구성.** regular/bold/italic/bold-italic 4 조합을 시스템에서 각각 best match 로 뽑고 **콘텐츠 해시로 중복 제거**한다. italic 이 regular 와 같은 파일로 해석되면 italic `@font-face` 를 만들지 않는다 — 브라우저의 합성 기울임에 맡기는 편이 정직하고 전송량도 아낀다.
6. **압축.** brotli 로 1 회 압축해 캐시하고 `Accept-Encoding: br` 인 클라이언트에만 압축본을 준다. 압축은 `spawn_blocking` 에서 수행한다. woff2 압축 이득의 대부분은 brotli 이고, glyf transform 이 주는 추가 이득(≈10%)은 C++ 툴체인 값을 못 한다.
7. **늦게 도착한 폰트의 재계측.** 클라이언트는 폰트가 아직 로드되지 않았으면 서버가 준 기존 스택을 그대로 쓰고, 로드가 끝난 뒤에만 별칭 family 를 스택 맨 앞에 붙인다. 문자열이 실제로 바뀌므로 xterm 이 셀 크기를 다시 재고, 이어서 fit 을 다시 돌린다. 렌더할 수 없는 폰트를 미리 선언해 두고 강제로 재계측을 유도하는 우회는 쓰지 않는다.
8. **라이선스 책임.** 토글 기본 off + 설정 문서에 재배포 경고를 명시해, 폰트 바이너리를 내보내는 선택을 사용자가 명시적으로 하도록 만든다. 앱은 폰트 라이선스를 판정하지 않는다.

## Alternatives Considered

- **woff2 로 변환해 서빙** — 원 요구안. 순수 Rust 인코더 부재로 C++ 빌드 의존이 생기고, 전송량 이득은 brotli 대비 10% 수준이라 기각. null transform(변환 없이 brotli 만) woff2 컨테이너를 직접 구성하는 안도 검토했으나, 그건 결국 brotli 를 폰트 컨테이너 안에 넣는 것이라 HTTP 압축과 이득이 같으면서 스펙 구현 부담만 늘어 기각.
- **번들된 OFL 폰트 몇 개만 제공** — 라이선스·용량이 완전히 안전하고 예측 가능하다. 하지만 "PC 와 같은 화면"이라는 요구를 못 채우고, 바이너리 크기를 상시 늘린다. 향후 폴백 개선안으로는 남겨 둘 수 있다.
- **폰트 서브셋팅 후 전송** — 용량은 크게 줄지만 터미널은 임의 코드포인트가 언제든 나올 수 있어 서브셋 대상을 미리 정할 수 없다. 동적 증분 서브셋은 이 규모에 과하다.
- **`.ttc` 에서 해당 face 추출** — sfnt 재조립이 필요하다. Windows 에 ttc 가 있긴 하나 주요 monospace 폰트는 단일 ttf 라 실익이 적어 이번 범위에서 제외하고 폴백으로 처리.
- **항상 켜기(토글 없음)** — 사용자가 모르는 사이에 독점 폰트를 relay 로 내보내게 된다. 네트워크 노출 정책 변경은 명시적 opt-in 이어야 한다.
- **`fontFamily` 를 잠깐 다른 값으로 바꿨다 되돌려 재계측 유도** — 동작은 하지만 상태를 거짓으로 만들었다 되돌리는 우회다. 별칭 family 를 로드 후에만 붙이는 쪽이 표현하는 사실과 실제가 일치한다.

## Consequences

- 토글을 켠 사용자는 모바일에서 데스크톱과 같은 글리프·advance 로 보고, fit 열 계산이 데스크톱과 수렴한다.
- 첫 로드에 페이스당 최대 8 MiB(brotli 후 대략 절반 이하)를 받는다. 이후에는 immutable 캐시로 재요청이 없다. 회선이 느리면 첫 화면은 폴백 폰트로 그려졌다가 폰트 도착 후 한 번 재계측·재fit 되며, 그 순간 화면이 한 번 흔들린다.
- 데스크톱 프로세스는 서빙 중인 페이스의 원본 바이트와 brotli 본을 메모리에 유지한다. face 캐시는 상한을 두고 초과 시 비운다.
- 새 의존성 2 개(`sha2`, `brotli`) 가 직접 의존으로 올라온다. 둘 다 순수 Rust 라 크로스 컴파일 영향은 없다.
- 데스크톱에서 폰트를 교체하면 face 캐시가 갱신되며 URL 토큰이 바뀌어 클라이언트가 새로 받는다. 반대로 **같은 이름으로 폰트 파일만 갈아끼우면**(폰트 재설치) 캐시가 이전 바이트를 들고 있을 수 있다 — 앱 재시작으로 해소되며 별도 무효화 경로는 두지 않는다.
- ttc 로만 설치된 폰트, 8 MiB 초과 폰트는 조용히 이름-only 폴백이 된다. 사용자가 "왜 안 바뀌지"를 겪을 수 있으므로 폴백 사유는 `tracing` 으로 남긴다.
- 재검토 조건: 순수 Rust woff2 인코더가 성숙하거나, 서브셋팅이 필요할 만큼 폰트 용량이 문제가 되거나, 라이선스 판정을 앱이 해야 할 요구가 생기면 이 결정을 다시 연다.
