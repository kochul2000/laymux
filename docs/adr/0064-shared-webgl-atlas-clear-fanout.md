# 0064. 공유 WebGL atlas 를 지운 쪽이 모든 터미널의 렌더 모델을 무효화한다

- Status: Proposed
- Date: 2026-07-26
- Source: issue #571, architecture/data-flow.md §8.4·§8.20, 선행 판정 [#534](https://github.com/kochul2000/laymux/issues/534)(재현 없이 닫음 — 미확인 조건 "멀티-pane shared atlas 경합" 이 이번에 재현됨)

## Context

`@xterm/addon-webgl@0.19.0` 의 texture atlas 는 **Terminal 인스턴스 사이에서 공유**된다. `CharAtlasCache.acquireTextureAtlas()` 는 render config(폰트·셀 크기·색·DPR·max texture size)가 같으면 기존 entry 에 `ownedBy.push(terminal)` 로 붙인다. laymux 처럼 같은 프로파일의 pane 을 여러 개 띄우면 그 pane 들은 **하나의 atlas 를 공유한다.**

그런데 atlas 를 비우는 `TextureAtlas.clearTexture()` 는 페이지와 `_cacheMap` 만 지우고 **`_requestClearModel` 을 세우지 않는다.** 이 플래그는 page merge(`TextureAtlas.ts:195`)와 oversized glyph overflow(`:798`)에서만 켜지며, 켜지면 `beginFrame()` 을 통해 **그 atlas 를 쓰는 모든 renderer** 가 자기 모델을 비운다. 반면 `clearTexture()` 경로에서는 호출자만 스스로 보정한다:

```ts
public clearTextureAtlas(): void {
  this._charAtlas?.clearTexture();
  this._clearModel(true);        // ← 호출한 terminal 하나만
  this._requestRedrawViewport();
}
```

laymux 는 `TerminalView` 의 `rebuildTerminalRenderer()` 에서 이 API 를 부른다 — hide→show 복구, 폰트/DPR 변경, 보류된 reflow 소비(§8.4). 즉 **한 pane 이 지운 atlas 를 나머지 pane 이 모른 채 계속 참조한다.** 남은 모델의 vertex 에는 지워진 페이지의 옛 texture 좌표가 박혀 있고, 그 자리에는 이후 다른 문자가 다시 rasterize 돼 들어간다. 옛 좌표로 샘플링하면 새 내용의 경계에 걸친 **조각**이 나온다 — 사용자 보고 그대로 "겹쳐 깨진 듯한, 완전한 글자가 아닌" 화면이다.

**계측으로 확인한 순서**(dev 19281, `VITE_LAYMUX_CURSOR_TRACE=1`):

```
11:06:23.710  atlas-clear  terminal-pane-5943cb14   ┐ 워크스페이스 복귀 일괄
11:06:23.711  atlas-clear  terminal-pane-9449a652   │ (같은 task, 모두 직후 리페인트)
11:06:23.713  atlas-clear  terminal-pane-d2b31e6c   ┘
11:06:24.238  atlas-clear  terminal-pane-d2b31e6c   ← 525ms 뒤 혼자 다시
```

늦은 clear 는 출력이 많은 pane 의 fit 이 write drain 을 기다리다 뒤늦게 실행된 것이다(§8.4 의 guarded fit). 이때 이미 리페인트를 끝낸 조용한 pane 들이 stale 이 된다. 그래서 **바쁜 pane 은 멀쩡하고 `watch` 처럼 조용한 pane 만 깨진 채 남는** 관찰이 나온다.

**리페인트로는 못 고친다.** `WebglRenderer._updateModel()` 은 셀의 code·색이 모델 캐시와 같으면 건너뛴다(`// Nothing has changed, no updates needed`). 그래서 `terminal.refresh(0, rows-1)` 은 행을 다시 훑지만 vertex 를 하나도 다시 쓰지 않고, 옛 좌표가 그대로 살아남는다. 실기에서 refresh-only 수정을 먼저 넣었다가 **증상이 그대로 재현**되는 것을 보고 이 사실을 확인했다.

## Decision

**atlas 를 지운 쪽이 그 사실을 알리고, 등록된 모든 터미널이 렌더러를 재구성한다.**

- 새 모듈 `ui/src/lib/webgl-atlas-rebuild.ts` 가 "atlas 가 지워졌다 → 누가 다시 그려야 하는가" 판정을 **단독으로** 소유한다. `TerminalView` 는 마운트 시 자기 재구성 콜백을 등록하고, `rebuildTerminalRenderer()` 에서 `notifyTextureAtlasCleared()` 로 보고한다.
- 재구성은 `refresh()` 가 아니라 **`clearTextureAtlas()` + 전체 viewport refresh** 다. 모델을 비워야 모든 셀이 `updateCell()` 을 다시 통과한다. `clearTexture()` 는 페이지가 이미 비어 있으면 early-return 하므로, 전원 호출은 첫 호출만 wipe 하고 나머지는 자기 모델만 비운다.
- 보고는 **microtask 하나로 coalesce** 한다. 워크스페이스 복귀처럼 한 task 안에서 여러 pane 이 지우는 경우 한 번의 pass 로 덮고, 다음 paint 전에 끝난다.
- 등록 키는 **terminal instance id 하나**다. paneId 로 두 번 등록하면 같은 터미널을 두 번 재구성한다.

## Alternatives Considered

- **`@xterm/addon-webgl` 패치 (`clearTexture()` 에서 `_requestClearModel = true`).** 원인 계층에 가장 가깝고 리포에 이미 xterm 패치 관문이 있다(`scripts/patch-xterm-reflow.mjs`). 채택하지 않은 이유: upstream 의 `_requestClearModel` 은 **한 번 켜지면 리셋되지 않는다.** 지금은 page merge 처럼 드문 사건에서만 켜지므로 감춰져 있지만, 우리가 매 hide/show·resize 마다 켜면 그 이후 모든 프레임이 영구적으로 full model clear 가 된다. 리셋까지 같이 고치면 upstream 의 merge 경로 동작을 바꾸는 것이라 패치 표면이 커진다.
- **공유 여부를 계산해 대상 pane 만 통보.** `generateConfig`/`configEquals` 를 우리 쪽에서 재현해야 하고, 그 순간 **같은 질문에 답하는 소유자가 둘**이 된다(§8.19 의 실패 패턴). upstream 이 config 키에 필드를 하나 추가하면 조용히 갈라진다. 전원 통보의 대가는 이미 리페인트가 일어나는 드문 사건에서의 모델 재구성 한 번이므로 이쪽이 싸다.
- **`refresh()` 만 보내기.** 위 Context 대로 실기에서 실패했다. `_updateModel` 의 skip 때문에 vertex 가 갱신되지 않는다.
- **출력 내용을 보고 atlas 를 복구하는 휴리스틱(#534 가 참조한 Orca 방식).** #534 의 비목표를 유지한다. atlas 를 지우는 주체가 이미 우리 코드이므로 감지가 필요 없다.

## Consequences

- hide/show·resize·폰트/DPR 변경 때마다 **모든 터미널**이 모델을 비우고 한 번 다시 그린다. 이 사건들은 원래 리페인트를 동반하므로 추가 비용은 pane 수에 비례하는 모델 재구성 1회다. 상시 출력 경로에는 영향이 없다.
- 한 task 안의 clear 는 한 pass 로 합쳐지지만, **task 가 다르면 pass 도 다르다.** 워크스페이스 복귀처럼 pane 별 ResizeObserver 콜백이 나뉘어 오면 pass 가 몇 번 더 돈다. 관측상 3 pass(6 터미널 × 3)였고, 이 정도는 허용한다 — rAF 로 넓히면 clear 와 재구성 사이에 프레임이 하나 끼어 깨진 프레임이 보일 수 있다.
- `atlas-rebuild` cursor-trace 이벤트를 남긴다. 이 결함은 계측 없이는 순서를 못 보므로(위 타임라인이 그 예) 게이트된 상태로 유지한다.
- **미검증**: 저사양 GPU·소프트웨어 렌더링 폴백, 서로 다른 폰트 config 가 섞인 pane 구성, 원격(브라우저) 렌더러. 확인한 조합은 Windows 11 / WebView2 / 같은 프로파일 pane 3–6개다.
