/**
 * 검증된 path-link 밑줄 위에 "Ctrl / Ctrl+Shift 로 무엇을 할 수 있는지" 를
 * 알려주는 떠 있는 힌트 라벨 (issue #687, ADR-0099).
 *
 * 수정자 클릭은 발견성이 0 이다 — 설정 화면을 열어본 사람만 알 수 있다.
 * 밑줄에 마우스를 올렸을 때(이미 `hitTest` 로 계산 중인 그 순간) 라벨을 띄워
 * 존재 자체를 알린다.
 *
 * DOM 만 다루고 React 를 거치지 않는다. 데코레이션·커서와 같은 이유다 —
 * 마우스가 움직일 때마다 TerminalView 를 리렌더할 수 없다(#363 참고).
 * 라벨 자체는 `pointer-events: none` 이라 클릭·드래그를 가로채지 않는다.
 */

/** 라벨과 밑줄 사이 간격(px). */
const GAP = 6;
/** 호스트 가장자리에서 최소한 띄울 여백(px). */
const EDGE_MARGIN = 4;

export interface PathLinkHint {
  /** 뷰포트 좌표 사각형 위(공간이 없으면 아래)에 라벨을 띄운다. */
  show: (rect: { left: number; right: number; top: number; bottom: number }, text: string) => void;
  /** 라벨을 숨긴다(요소는 재사용을 위해 남긴다). */
  hide: () => void;
  /** 요소를 제거한다. effect cleanup 용. */
  dispose: () => void;
}

/**
 * `host`(터미널 wrapper, `position: relative`) 안에 힌트 라벨을 만든다.
 * 좌표는 뷰포트 기준으로 받아 host 기준으로 변환하므로, 호출부는 데코레이션
 * `getBoundingClientRect()` 를 그대로 넘기면 된다.
 *
 * `host` 가 아직 없으면(마운트 전) 아무것도 하지 않는 no-op 을 돌려준다 —
 * 힌트는 보조 표시이므로 호출부가 존재 여부를 분기하지 않아도 되게 한다.
 */
export function createPathLinkHint(host: HTMLElement | null): PathLinkHint {
  if (!host) {
    return { show: () => {}, hide: () => {}, dispose: () => {} };
  }
  const el = document.createElement("div");
  el.className = "terminal-path-link-hint";
  el.dataset.testid = "path-link-hint";
  el.hidden = true;
  host.appendChild(el);

  return {
    show: (rect, text) => {
      if (!text) {
        el.hidden = true;
        return;
      }
      // 문구가 바뀔 때만 쓴다 — mousemove 마다 textContent 를 갱신하면 매번
      // 레이아웃이 무효화된다.
      if (el.textContent !== text) el.textContent = text;
      el.hidden = false;

      const hostRect = host.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;

      // 기본은 밑줄 위. 위쪽 공간이 부족하면 아래로 뒤집는다.
      let top = rect.top - hostRect.top - height - GAP;
      if (top < EDGE_MARGIN) top = rect.bottom - hostRect.top + GAP;

      // 밑줄 왼쪽 끝 정렬 후 host 안으로 클램프(오른쪽으로 넘치지 않게).
      let left = rect.left - hostRect.left;
      const maxLeft = hostRect.width - width - EDGE_MARGIN;
      if (left > maxLeft) left = maxLeft;
      if (left < EDGE_MARGIN) left = EDGE_MARGIN;

      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
    },
    hide: () => {
      el.hidden = true;
    },
    dispose: () => {
      el.remove();
    },
  };
}
