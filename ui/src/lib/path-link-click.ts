/**
 * 검증된 path-link 밑줄에 대한 mousedown/mouseup 처리 (issue #687, ADR-0100).
 *
 * `TerminalView` 의 effect 안에 인라인으로 두면 소유권 계약(수정자 클릭에서만
 * 이벤트를 종결한다)과 확인 게이트(취소하면 아무 일도 일어나지 않는다)를
 * 테스트할 방법이 없다. 그래서 DOM·스토어·i18n 의존을 전부 주입으로 받고
 * 여기서는 순수한 상태 기계만 돌린다. `TerminalView` 는 배선만 한다.
 */

import type { LinkAction, LinkActivationMode, LinkActivationResult } from "./link-activation";
import { decideLinkActivation } from "./link-activation";
import { needsOsHandoffConfirm } from "./os-handoff";
import type { PathLinkClickAction } from "./path-link-os-open";
import {
  isOsHandoffAction,
  osHandoffModeForAction,
  pathLinkActionForChipAction,
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
  /** `terminal.pathLinkActivation`(ADR-0224). `chip` 이면 클릭이 칩만 띄운다. */
  activation: LinkActivationMode;
}

export interface PathLinkClickDeps<T extends PathLinkClickTarget> {
  /** 뷰포트 좌표 아래의 검증된 선택(없으면 null). */
  getSelectionAt: (clientX: number, clientY: number) => T | null;
  /** 클릭 시점의 설정 스냅샷. */
  getSettings: () => PathLinkClickSettings;
  /** 확인 대화상자. 계속하면 true. */
  confirm: (input: { path: string; isDirectory: boolean }) => boolean;
  /** 결정된 액션 실행(컨트롤러 라우팅). */
  activate: (target: T, action: PathLinkClickAction) => void;
  /**
   * ADR-0224 `chip` 모드: 실행하지 않고 칩을 띄운다. 칩 렌더·수명은 호출부
   * (`link-chip-session.ts`)가 소유하므로 여기서는 대상·액션 목록·클릭 지점만
   * 넘긴다.
   */
  showChip: (
    target: T,
    actions: readonly LinkAction[],
    point: { clientX: number; clientY: number },
  ) => void;
  /**
   * 호스트 OS 위임 경로가 끝났을 때(진행·취소 **모두**) 호출. mousedown 을
   * preventDefault 해 포커스가 이동하지 않았고 네이티브 확인 대화상자가
   * 포커스를 가져가므로, 여기서 터미널 포커스를 되돌린다.
   */
  onOsHandoffSettled?: () => void;
}

/**
 * 호스트 OS 위임의 확인 게이트. 진행해도 되면 true.
 *
 * 클릭 경로와 액션 칩 경로가 **같은 정책 한 벌**을 쓰게 하려고 분리했다 —
 * ADR-0100 Decision 3(하드 클래스는 설정과 무관하게 항상 확인)이 칩에서도
 * 그대로 성립해야 하고, ADR-0224 는 칩이 "기존 액션의 표시 방식일 뿐"이라고
 * 못박았다.
 */
export function passOsHandoffGate(
  target: PathLinkClickTarget,
  action: PathLinkClickAction,
  deps: {
    getSettings: () => PathLinkClickSettings;
    confirm: (input: { path: string; isDirectory: boolean }) => boolean;
    onOsHandoffSettled?: () => void;
  },
): boolean {
  const mode = osHandoffModeForAction(action);
  if (!mode) return true;
  const mustConfirm = needsOsHandoffConfirm({
    mode,
    path: target.absPath,
    isDirectory: target.isDirectory,
    confirmAlways: deps.getSettings().confirmAlways,
  });
  if (mustConfirm && !deps.confirm({ path: target.absPath, isDirectory: target.isDirectory })) {
    deps.onOsHandoffSettled?.();
    return false;
  }
  deps.onOsHandoffSettled?.();
  return true;
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
  let press: { target: T; result: LinkActivationResult; x: number; y: number } | null = null;

  /** 이 press 가 mousedown 을 종결한 조합인지(= 호스트 OS 직행). */
  const ownsEvent = (result: LinkActivationResult): boolean => {
    if (result.kind !== "open-direct") return false;
    const action = pathLinkActionForChipAction(result.action);
    return action !== null && isOsHandoffAction(action);
  };

  return {
    onMouseDown: (e) => {
      press = null;
      if (e.button !== 0) return;
      const target = deps.getSelectionAt(e.clientX, e.clientY);
      if (!target) return;

      const settings = deps.getSettings();
      // ADR-0224: 모드·대상·수정자 → 결과 매핑은 link-activation 이 소유한다.
      // Ctrl / Ctrl+Shift 는 모드와 무관하게 여기서 직행으로 돌아온다.
      const result = decideLinkActivation({
        mode: settings.activation,
        surface: "desktop",
        target: target.isDirectory ? "directory" : "file",
        modifiers: e,
        osOpenEnabled: settings.osOpenEnabled,
      });
      press = { target, result, x: e.clientX, y: e.clientY };

      // 소유권 불변식: 호스트 OS 위임 조합만 이벤트를 종결한다. 나머지 클릭은
      // 그대로 흘려보내 xterm 선택·드래그와 #352 우회를 해치지 않는다. 칩 모드의
      // 클릭도 "관찰"이다 — 칩은 mouseup 에서 뜬다.
      if (ownsEvent(result)) {
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
      if (moved) {
        // 드래그 → 열지 않음(재선택 의도). 다만 mousedown 을 preventDefault 한
        // 조합이면 포커스가 이동하지 않았으므로 여기서도 되돌려 준다.
        if (ownsEvent(current.result)) deps.onOsHandoffSettled?.();
        return;
      }

      if (current.result.kind === "show-chip") {
        // 실행하지 않는다 — 칩만 띄운다(ADR-0224 "클릭 = 무장, 칩 = 실행").
        deps.showChip(current.target, current.result.actions, {
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
      if (current.result.kind !== "open-direct") return;

      // path 대상의 직행 액션은 뷰어·cwd·OS 넷뿐이다(브라우저·복사는 URL·칩 소관).
      const action = pathLinkActionForChipAction(current.result.action);
      if (!action) return;
      if (!passOsHandoffGate(current.target, action, deps)) return;
      deps.activate(current.target, action);
    },
  };
}
