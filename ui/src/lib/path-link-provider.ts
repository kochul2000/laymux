/**
 * 터미널에서 사용자가 *선택(드래그)* 한 (상대/절대) 파일·디렉토리 경로에
 * 밑줄을 긋고, 클릭하면 파일은 viewer 로 열고 디렉토리는 cwd 로 전파하는
 * 컨트롤러 (issue #363, 선택 기반).
 *
 * ## 왜 ILinkProvider 가 아니라 데코레이션인가
 * xterm 의 ILinkProvider/Linkifier 는 **마우스 이동(mousemove) 시점에만**
 * provideLinks 를 재질의하고, 같은 셀 위에서는 재질의를 건너뛴다. 우리 모델은
 * 비동기 stat 검증이 끝난 *뒤* (마우스가 정지한 상태에서) 밑줄/클릭을 켜야
 * 하는데, linkifier 에 의존하면 "마우스를 나갔다 돌아와야" 동작하는 문제가
 * 생긴다(검증 시점과 hover 재질의 시점이 어긋남). 그래서 hover 모델에 기대지
 * 않고, 검증이 끝난 즉시 **데코레이션(IDecoration)** 으로 밑줄을 직접 그리고
 * 그 DOM 요소에 클릭 핸들러를 붙인다.
 */

import type { Terminal, IDecoration, IMarker } from "@xterm/xterm";

/** 검증된 선택 경로의 버퍼 범위 + 메타. */
export interface VerifiedPathSelection {
  /** 1-based 절대 버퍼 라인. 단일 라인 가정. */
  bufferLine: number;
  /** 1-based 시작 컬럼(inclusive). */
  startCol: number;
  /** 1-based 끝 컬럼(inclusive). */
  endCol: number;
  /** cwd 와 조합·검증된 절대 경로. */
  absPath: string;
  /** 디렉토리면 true(클릭 시 cwd 전파), 파일이면 false(viewer). */
  isDirectory: boolean;
}

export interface PathLinkControllerDeps {
  /** 검증된 파일 경로 클릭 시 호출 — viewer 로 연다. */
  onOpenPath: (absPath: string) => void;
  /** 검증된 디렉토리 경로 클릭 시 호출 — 해당 경로로 cwd 전파. */
  onChangeDir: (absPath: string) => void;
}

export interface PathLinkController {
  /** 검증된 선택 범위를 저장하고 밑줄 데코레이션을 그린다. */
  setVerifiedSelection: (sel: VerifiedPathSelection) => void;
  /** 저장 상태와 데코레이션을 비운다(선택 해제/변경 시). */
  clear: () => void;
  /** 현재 검증 상태(테스트/디버그용). */
  getCurrent: () => VerifiedPathSelection | null;
  /** viewport 좌표가 현재 밑줄(데코레이션) 영역 안인지. 없으면 false. */
  hitTest: (clientX: number, clientY: number) => boolean;
  /** 주어진 선택을 파일/디렉토리에 따라 onOpenPath/onChangeDir 로 라우팅. */
  activate: (sel: VerifiedPathSelection) => void;
}

/**
 * 선택 기반 path-link 컨트롤러를 만든다. 검증된 선택이 설정되면 그 범위에
 * 밑줄 데코레이션을 그리고, 데코레이션 요소 클릭을 파일/디렉토리에 따라
 * onOpenPath/onChangeDir 로 라우팅한다.
 */
export function createPathLinkController(
  terminal: Terminal,
  deps: PathLinkControllerDeps,
): PathLinkController {
  let current: VerifiedPathSelection | null = null;
  let decoration: IDecoration | undefined;
  let marker: IMarker | undefined;

  const disposeDecoration = () => {
    decoration?.dispose();
    marker?.dispose();
    decoration = undefined;
    marker = undefined;
  };

  const styleEl = (el: HTMLElement) => {
    // 순수 시각(밑줄)만 담당. pointer-events:none 으로 두어 클릭/드래그가
    // 그대로 xterm 으로 전달되게 한다(재드래그로 재선택 가능, 커서·클릭은
    // TerminalView 가 hit-test 로 처리). 커서도 여기서 안 건다.
    el.style.borderBottom = "1px solid currentColor";
    el.style.boxSizing = "border-box";
    el.style.pointerEvents = "none";
  };

  return {
    setVerifiedSelection: (sel: VerifiedPathSelection) => {
      disposeDecoration();
      current = sel;

      // 데코레이션 생성은 절대 호출부 체인을 깨지 않는다(밑줄 실패해도 커서·클릭
      // 라우팅은 동작해야 한다). registerMarker 는 정수 오프셋만 받고 throw 할 수
      // 있으므로 방어적으로 감싼다.
      try {
        // registerMarker(offset) 는 커서 절대 라인 기준 상대 오프셋에 마커를 단다.
        const buffer = terminal.buffer.active;
        const cursorAbsY = (buffer.baseY ?? 0) + (buffer.cursorY ?? 0); // 0-based 절대 라인
        const targetAbsY = sel.bufferLine - 1; // 0-based 절대 라인
        const offset = Math.trunc(targetAbsY - cursorAbsY);
        if (!Number.isFinite(offset)) return;
        const m = terminal.registerMarker(offset);
        if (!m) return; // 라인이 버퍼 밖이면 데코레이션 생략(밑줄만 없음).
        marker = m;

        const width = Math.max(1, sel.endCol - sel.startCol + 1);
        const dec = terminal.registerDecoration({
          marker: m,
          x: Math.max(0, sel.startCol - 1), // 0-based 셀
          width,
        });
        if (!dec) return;
        decoration = dec;
        // 최초 렌더 + 이후 재렌더(스크롤/리사이즈)마다 스타일 보장.
        if (dec.element) styleEl(dec.element);
        dec.onRender((el) => styleEl(el));
      } catch (err) {
        console.warn("[pathLink] 밑줄 데코레이션 생성 실패:", err);
      }
    },
    clear: () => {
      current = null;
      disposeDecoration();
    },
    getCurrent: () => current,
    hitTest: (clientX: number, clientY: number) => {
      const el = decoration?.element;
      if (!current || !el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    },
    activate: (sel: VerifiedPathSelection) => {
      if (sel.isDirectory) deps.onChangeDir(sel.absPath);
      else deps.onOpenPath(sel.absPath);
    },
  };
}
