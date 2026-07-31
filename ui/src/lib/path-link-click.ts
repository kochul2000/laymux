/**
 * 검증된 path-link 밑줄에 대한 mousedown/mouseup 처리 (issue #687, ADR-0099).
 *
 * `TerminalView` 의 effect 안에 인라인으로 두면 소유권 계약(수정자 클릭에서만
 * 이벤트를 종결한다)과 확인 게이트(취소하면 아무 일도 일어나지 않는다)를
 * 테스트할 방법이 없다. 그래서 DOM·스토어·i18n 의존을 전부 주입으로 받고
 * 여기서는 순수한 상태 기계만 돌린다. `TerminalView` 는 배선만 한다.
 */

import type { PathLinkClickAction } from "./path-link-os-open";
import {
  decidePathLinkClickAction,
  isOsHandoffAction,
  needsOsOpenConfirm,
} from "./path-link-os-open";

/** 드래그로 간주할 이동 거리(px). 이 이상 움직이면 재선택 의도로 본다. */
export const PATH_LINK_CLICK_SLOP = 4;

/** 클릭 대상(검증된 선택). `VerifiedPathSelection` 이 이 형태를 만족한다. */
export interface PathLinkClickTarget {
  absPath: string;
  isDirectory: boolean;
}

/** 핸들러가 실제로 읽는 마우스 이벤트 필드만 추린 형태. */
export interface PathLinkMouseEvent {
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
}

export interface PathLinkClickSettings {
  /** `terminal.pathLinkOsOpenEnabled`. */
  osOpenEnabled: boolean;
  /** `terminal.pathLinkOsOpenConfirm`. */
  confirmAlways: boolean;
}

export interface PathLinkClickDeps<T extends PathLinkClickTarget> {
  /** 현재 검증된 선택(없으면 null). */
  getSelection: () => T | null;
  /** 뷰포트 좌표가 밑줄 사각형 안인지. */
  hitTest: (clientX: number, clientY: number) => boolean;
  /** 클릭 시점의 설정 스냅샷. */
  getSettings: () => PathLinkClickSettings;
  /** 확인 대화상자. 계속하면 true. */
  confirm: (input: { path: string; isDirectory: boolean }) => boolean;
  /** 결정된 액션 실행(컨트롤러 라우팅). */
  activate: (target: T, action: PathLinkClickAction) => void;
  /**
   * 호스트 OS 위임 경로가 끝났을 때(진행·취소 **모두**) 호출. mousedown 을
   * preventDefault 해 포커스가 이동하지 않았고 네이티브 확인 대화상자가
   * 포커스를 가져가므로, 여기서 터미널 포커스를 되돌린다.
   */
  onOsHandoffSettled?: () => void;
}

export interface PathLinkClickHandlers {
  onMouseDown: (e: PathLinkMouseEvent) => void;
  onMouseUp: (e: PathLinkMouseEvent) => void;
}

/**
 * 밑줄 클릭 핸들러 한 쌍을 만든다.
 *
 * 클릭 시 xterm 이 선택을 지워 `getSelection()` 이 비므로, 대상과 액션은
 * **mousedown 시점에 캡처**해 두고 mouseup 에서 실행한다.
 */
export function createPathLinkClickHandlers<T extends PathLinkClickTarget>(
  deps: PathLinkClickDeps<T>,
): PathLinkClickHandlers {
  let press: { target: T; action: PathLinkClickAction; x: number; y: number } | null = null;

  return {
    onMouseDown: (e) => {
      press = null;
      if (e.button !== 0) return;
      const target = deps.getSelection();
      if (!target || !deps.hitTest(e.clientX, e.clientY)) return;

      const action = decidePathLinkClickAction(
        e,
        target.isDirectory,
        deps.getSettings().osOpenEnabled,
      );
      press = { target, action, x: e.clientX, y: e.clientY };

      // 소유권 불변식: 호스트 OS 위임 조합만 이벤트를 종결한다. 나머지 클릭은
      // 그대로 흘려보내 xterm 선택·드래그와 #352 우회를 해치지 않는다.
      if (isOsHandoffAction(action)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    },
    onMouseUp: (e) => {
      const current = press;
      press = null;
      if (!current) return;
      const moved =
        Math.abs(e.clientX - current.x) > PATH_LINK_CLICK_SLOP ||
        Math.abs(e.clientY - current.y) > PATH_LINK_CLICK_SLOP;
      if (moved) return; // 드래그 → 열지 않음(재선택 의도).

      if (isOsHandoffAction(current.action)) {
        const settings = deps.getSettings();
        const mustConfirm = needsOsOpenConfirm({
          action: current.action,
          path: current.target.absPath,
          isDirectory: current.target.isDirectory,
          confirmAlways: settings.confirmAlways,
        });
        if (mustConfirm) {
          const proceed = deps.confirm({
            path: current.target.absPath,
            isDirectory: current.target.isDirectory,
          });
          if (!proceed) {
            deps.onOsHandoffSettled?.();
            return;
          }
        }
        deps.onOsHandoffSettled?.();
      }

      deps.activate(current.target, current.action);
    },
  };
}
