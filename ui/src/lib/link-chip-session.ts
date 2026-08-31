/**
 * 링크 액션 칩의 **수명과 라우팅** ([ADR-0224](../../../docs/adr/0224-link-activation-chip-gate.md)).
 *
 * 칩은 surface-local UI 상태다 — settings 에도 localStorage 에도 저장하지 않는다
 * (ADR-0004). 그래서 이 모듈은 스토어를 모르고, DOM 뷰(`link-chip.ts`)·실행
 * 라우팅·원문 생존 판정을 전부 주입으로 받는다. 남는 것은 계약 그 자체다.
 *
 *   - **한 번에 칩 하나.** 새 실행 제스처는 기존 칩을 교체한다.
 *   - **수명은 밑줄 수명에 종속.** 칩이 가리키는 원문이 재검증에서 폐기되면
 *     칩도 소멸한다(ADR-0220 안정 프레임 계약을 공유하며, 별도 수명 규칙을
 *     만들지 않는다). URL 은 밑줄 엔트리가 없으므로 칩 생성 시점의
 *     (버퍼 라인, 컬럼 범위, 원문) 캡처에 같은 판정을 적용한다.
 *   - 그 외 Esc, 칩 밖 클릭/탭, 스크롤, 선택 시작, terminal/lease/워크스페이스
 *     전환, resize 도 칩을 소멸시킨다.
 */

import type { LinkAction, LinkTargetKind } from "./link-activation";
import type { LinkChipAnchor, LinkChipItem } from "./link-chip";

/** 칩이 소멸한 이유. 로깅·테스트 가독성용이며 동작은 모두 같다(감춘다). */
export type LinkChipDismissReason =
  /** Esc 키. */
  | "escape"
  /** 칩 밖 클릭/탭. */
  | "outside"
  /** 터미널 스크롤. */
  | "scroll"
  /** 선택 시작/변경. */
  | "selection"
  /** terminal·lease·워크스페이스 전환. */
  | "switch"
  /** resize·reflow(셀 좌표계 변경). */
  | "resize"
  /** 대상 원문이 재검증에서 폐기됨. */
  | "stale"
  /** 액션 실행 완료. */
  | "action"
  /** 새 실행 제스처가 칩을 교체. */
  | "replaced"
  /** 컨트롤러 폐기(unmount·teardown). */
  | "dispose";

/**
 * 칩이 가리키는 대상의 캡처. 좌표 모델은 밑줄 데코레이션과 같다
 * (1-based 절대 버퍼 라인, 1-based 셀, `endCol` inclusive).
 */
export interface LinkChipTargetShape {
  kind: LinkTargetKind;
  /** 실행 대상 — path 는 절대 경로, url 은 URL 원문. 복사 액션도 이 값을 쓴다. */
  value: string;
  bufferLine: number;
  startCol: number;
  endCol: number;
  /** 화면에 쓰인 원문. 생존 판정의 기준이다. */
  token: string;
}

export interface LinkChipSessionDeps<T extends LinkChipTargetShape> {
  /** DOM 뷰. */
  view: {
    show: (anchor: LinkChipAnchor, items: readonly LinkChipItem[]) => void;
    hide: () => void;
    contains: (node: unknown) => boolean;
    onSelect: (handler: (action: LinkAction) => void) => void;
  };
  /** 액션 라벨(i18n). */
  labelFor: (action: LinkAction, kind: LinkTargetKind) => string;
  /** 선택된 액션을 실행한다. 확인 게이트는 여기(호출부)가 소유한다. */
  run: (target: T, action: LinkAction) => void;
  /**
   * 캡처한 원문이 캡처한 자리에 아직 있는지. `revalidate()` 가 이 값으로만
   * 판정한다 — 안정 프레임 여부는 호출부(ADR-0220 소유자)가 정한다.
   */
  isTokenAlive: (target: T) => boolean;
}

export interface LinkChipSession<T extends LinkChipTargetShape> {
  /** 칩을 띄운다(기존 칩은 교체). 액션 목록이 비면 아무것도 하지 않는다. */
  open: (input: { target: T; anchor: LinkChipAnchor; actions: readonly LinkAction[] }) => void;
  /** 칩이 떠 있는지. */
  isOpen: () => boolean;
  /** 현재 대상(없으면 null). */
  target: () => T | null;
  /** 칩을 소멸시킨다. 떠 있지 않으면 아무 일도 하지 않는다. */
  dismiss: (reason: LinkChipDismissReason) => void;
  /**
   * 포인터가 내려간 노드가 칩 밖이면 소멸시킨다. 칩 안이면 유지한다
   * (버튼 클릭이 자기 자신을 지우지 않게).
   */
  handlePointerDown: (node: unknown) => void;
  /** 키 입력. Esc 를 소비했으면 true — 호출부가 그때만 이벤트를 종결한다. */
  handleKeyDown: (key: string) => boolean;
  /** 안정 프레임에서 원문 생존을 재검사한다(죽었으면 `stale` 로 소멸). */
  revalidate: () => void;
}

/**
 * 칩 세션 하나를 만든다. 세션은 뷰 하나를 소유하므로 terminal(또는 Remote
 * 페이지) 당 하나만 만든다 — "한 번에 칩 하나"가 이 구조로 보장된다.
 */
export function createLinkChipSession<T extends LinkChipTargetShape>(
  deps: LinkChipSessionDeps<T>,
): LinkChipSession<T> {
  let current: T | null = null;

  const hide = (): void => {
    current = null;
    deps.view.hide();
  };

  const session: LinkChipSession<T> = {
    open: ({ target, anchor, actions }) => {
      if (actions.length === 0) {
        // 표현할 액션이 없다 — 칩을 띄우면 빈 상자만 남는다.
        if (current) hide();
        return;
      }
      current = target;
      deps.view.show(
        anchor,
        actions.map((action) => ({ action, label: deps.labelFor(action, target.kind) })),
      );
    },
    isOpen: () => current !== null,
    target: () => current,
    dismiss: (_reason) => {
      if (!current) return;
      hide();
    },
    handlePointerDown: (node) => {
      if (!current) return;
      if (deps.view.contains(node)) return;
      hide();
    },
    handleKeyDown: (key) => {
      if (!current) return false;
      if (key !== "Escape") return false;
      hide();
      return true;
    },
    revalidate: () => {
      const target = current;
      if (!target) return;
      if (deps.isTokenAlive(target)) return;
      hide();
    },
  };

  deps.view.onSelect((action) => {
    const target = current;
    if (!target) return;
    // 실행 전에 칩을 거둔다 — 확인 대화상자가 뜨는 액션에서 칩이 대화상자 뒤에
    // 남아 있으면, 취소 후에도 같은 칩이 살아 있는 것처럼 보인다.
    hide();
    deps.run(target, action);
  });

  return session;
}
