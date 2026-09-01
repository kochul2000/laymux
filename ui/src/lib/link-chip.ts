/**
 * 링크 액션 칩의 DOM 뷰 ([ADR-0224](../../../docs/adr/0224-link-activation-chip-gate.md)).
 *
 * `chip` 모드에서 실행 제스처(클릭)는 링크를 열지 않고 대상 옆에 이 칩을 띄우며,
 * 칩의 버튼을 눌러야 실행된다. 힌트 라벨(`path-link-hint.ts`)과 같은 이유로
 * React 를 거치지 않고 DOM 만 다루지만, 힌트와 달리 **입력을 받는다** —
 * `pointer-events` 를 켜고 버튼을 렌더한다.
 *
 * 수명(무엇이 칩을 소멸시키는가)과 라우팅은 `link-chip-session.ts` 가 소유한다.
 * 이 모듈은 "그려라 / 감춰라 / 이 노드가 내 안인가" 세 가지만 안다.
 */

import type { LinkChipAction } from "./link-activation";

/** 칩과 링크 사이 간격(px). */
const GAP = 6;
/** host 가장자리에서 최소한 띄울 여백(px). */
const EDGE_MARGIN = 4;

/** 칩을 붙일 기준 사각형(뷰포트 좌표). 링크 밑줄 사각형 또는 포인터 지점. */
export interface LinkChipAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 칩 버튼 하나. */
export interface LinkChipItem {
  action: LinkChipAction;
  label: string;
}

export interface LinkChipView {
  /** 기준 사각형 아래(공간이 없으면 위)에 버튼 목록을 띄운다. */
  show: (anchor: LinkChipAnchor, items: readonly LinkChipItem[]) => void;
  /** 칩을 감춘다(요소는 재사용을 위해 남긴다). */
  hide: () => void;
  /** 지금 보이는지. */
  isOpen: () => boolean;
  /** 주어진 노드가 칩 안(또는 칩 자신)인지 — 칩 밖 클릭 판정용. */
  contains: (node: unknown) => boolean;
  /** 버튼 클릭 콜백을 등록한다(하나만 유지). */
  onSelect: (handler: (action: LinkChipAction) => void) => void;
  /** 요소를 제거한다. effect cleanup 용. */
  dispose: () => void;
}

/** DOM 이 없을 때(마운트 전) 쓰는 no-op 뷰. 호출부가 존재 여부를 분기하지 않게 한다. */
function noopView(): LinkChipView {
  return {
    show: () => {},
    hide: () => {},
    isOpen: () => false,
    contains: () => false,
    onSelect: () => {},
    dispose: () => {},
  };
}

/**
 * `host`(터미널 wrapper, `position: relative`) 안에 액션 칩을 만든다. 좌표는
 * 뷰포트 기준으로 받아 host 기준으로 변환하므로, 호출부는 데코레이션
 * `getBoundingClientRect()` 나 포인터 좌표를 그대로 넘기면 된다.
 */
export function createLinkChip(host: HTMLElement | null): LinkChipView {
  if (!host) return noopView();

  const el = document.createElement("div");
  el.className = "terminal-link-chip";
  el.dataset.testid = "link-chip";
  el.hidden = true;
  host.appendChild(el);

  let handler: ((action: LinkChipAction) => void) | null = null;

  // 칩은 터미널 wrapper 의 자식이고, 이 칩을 위협하는 리스너(path-link 의
  // mousedown, 칩 밖-클릭 소멸)는 전부 **capture 단계나 window** 에 달려 있다.
  // 그러므로 여기서 bubble 단계에 stopPropagation 을 걸어도 그것들보다 먼저
  // 돌 수 없다 — 칩 소유권은 그 리스너들이 `contains()` 로 자기 이벤트를
  // 알아보고 물러나는 방식으로 성립한다(`isChipEvent`/`linkChipContains`).
  // 아래 click 핸들러의 종결은 그 뒤에 오는 wrapper bubble 소비자만 막는다.
  el.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-link-chip-action]",
    );
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.linkChipAction as LinkChipAction | undefined;
    if (action) handler?.(action);
  });

  return {
    show: (anchor, items) => {
      if (items.length === 0) {
        el.hidden = true;
        return;
      }
      el.replaceChildren(
        ...items.map((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "terminal-link-chip-action";
          button.dataset.linkChipAction = item.action;
          button.textContent = item.label;
          return button;
        }),
      );
      el.hidden = false;

      const hostRect = host.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;

      // 기본은 링크 아래 — 밑줄 위쪽은 hover 힌트(ADR-0100)의 자리이고, 칩은
      // 대상 자체를 가리지 않아야 한다. 아래 공간이 부족하면 위로 뒤집는다.
      let top = anchor.bottom - hostRect.top + GAP;
      if (top + height > hostRect.height - EDGE_MARGIN) {
        top = anchor.top - hostRect.top - height - GAP;
      }
      if (top < EDGE_MARGIN) top = EDGE_MARGIN;

      // 링크 왼쪽 끝 정렬 후 host 안으로 클램프.
      let left = anchor.left - hostRect.left;
      const maxLeft = hostRect.width - width - EDGE_MARGIN;
      if (left > maxLeft) left = maxLeft;
      if (left < EDGE_MARGIN) left = EDGE_MARGIN;

      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
    },
    hide: () => {
      el.hidden = true;
    },
    isOpen: () => !el.hidden,
    contains: (node) => node instanceof Node && el.contains(node),
    onSelect: (next) => {
      handler = next;
    },
    dispose: () => {
      handler = null;
      el.remove();
    },
  };
}
