/**
 * 터미널에서 발견한 (상대/절대) 파일·디렉토리 경로에 밑줄을 긋고, 클릭하면
 * 파일은 viewer 로 열고 디렉토리는 cwd 로 전파하는 컨트롤러 (issue #363).
 *
 * 발견 트리거는 세 가지이며 각각 자기 scope 의 밑줄만 소유한다(ADR-0188):
 * `selection`(드래그 선택), `point`(hover dwell·클릭·Remote 탭),
 * `screen`(Remote 유휴 화면 스캔).
 *
 * ## 왜 ILinkProvider 가 아니라 데코레이션인가
 * xterm 의 ILinkProvider/Linkifier 는 **마우스 이동(mousemove) 시점에만**
 * provideLinks 를 재질의하고, 같은 셀 위에서는 재질의를 건너뛴다. 우리 모델은
 * 비동기 stat 검증이 끝난 *뒤* (마우스가 정지한 상태에서) 밑줄/클릭을 켜야
 * 하는데, linkifier 에 의존하면 "마우스를 나갔다 돌아와야" 동작하는 문제가
 * 생긴다(검증 시점과 hover 재질의 시점이 어긋남). 그래서 hover 모델에 기대지
 * 않고, 검증이 끝난 즉시 **데코레이션(IDecoration)** 으로 밑줄을 직접 그리고
 * `TerminalView`가 pointer 좌표로 정확한 데코레이션을 hit-test한다.
 */

import type { Terminal, IDecoration, IMarker } from "@xterm/xterm";
import type { OsHandoffMode } from "./os-handoff";
import type { PathLinkClickAction } from "./path-link-os-open";
import { readLineCells, reconstructLine } from "./terminal-cell-map";

/**
 * 검증된 링크의 소유 scope(ADR-0188). 세 트리거는 서로의 밑줄을 건드리지 않고
 * 자기 scope 만 교체·해제하며, hit-test 만 전체를 함께 본다.
 */
export type PathLinkScope = "selection" | "point" | "screen";

const PATH_LINK_SCOPES: readonly PathLinkScope[] = ["selection", "point", "screen"];

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
  /**
   * 밑줄 아래의 원문 토큰. 화면 재출력으로 그 자리 텍스트가 바뀌었는지
   * `revalidate()` 가 이 값으로 판정한다(ADR-0188).
   */
  token: string;
}

export interface PathLinkControllerDeps {
  /** 검증된 파일 경로 클릭 시 호출 — viewer 로 연다. */
  onOpenPath: (absPath: string) => void;
  /** 검증된 디렉토리 경로 클릭 시 호출 — 해당 경로로 cwd 전파. */
  onChangeDir: (absPath: string) => void;
  /**
   * 호스트 OS 로 위임할 때 호출(ADR-0100). 확인 대화상자는 호출부가 이미
   * 처리한 뒤이며, 여기서는 라우팅만 한다.
   */
  onOsAction: (absPath: string, mode: OsHandoffMode) => void;
}

export interface PathLinkController {
  /**
   * 한 scope 의 검증 범위를 교체하고 각각 밑줄 데코레이션을 그린다. 다른
   * scope 의 밑줄은 건드리지 않는다.
   */
  setVerifiedSelections: (scope: PathLinkScope, selections: VerifiedPathSelection[]) => void;
  /** scope 하나(또는 생략 시 전부)의 상태와 데코레이션을 비운다. */
  clear: (scope?: PathLinkScope) => void;
  /** 현재 검증 상태(테스트/디버그용). scope 를 주면 그 scope 만. */
  getCurrent: (scope?: PathLinkScope) => readonly VerifiedPathSelection[];
  /**
   * 밑줄 아래 원문이 그 자리에 남아 있는지 다시 확인하고, 화면 재출력으로
   * 텍스트가 바뀐 항목을 폐기한다. 폐기한 개수를 돌려준다(ADR-0188).
   */
  revalidate: () => number;
  /** viewport 좌표 아래의 검증 경로와 사각형. 없으면 null. */
  getHit: (
    clientX: number,
    clientY: number,
  ) => { selection: VerifiedPathSelection; rect: DOMRect } | null;
  /**
   * 주어진 선택을 결정된 액션에 따라 라우팅. 액션 판정(수정자 해석·설정
   * 반영·확인 대화상자)은 호출부가 `path-link-os-open` 의 순수 함수로 한다.
   */
  activate: (sel: VerifiedPathSelection, action: PathLinkClickAction) => void;
}

/**
 * 밑줄이 덮은 셀에 아직 같은 토큰이 있는지 확인한다(ADR-0188).
 *
 * 저장된 `bufferLine` 은 scrollback trim 으로 밀릴 수 있으므로, 마커가 살아
 * 있으면 마커의 현재 라인을 신뢰한다(마커는 xterm 이 따라 움직여 준다).
 * 라인을 읽을 수 없거나 시작 컬럼의 문자열이 달라졌으면 폐기 대상이다.
 */
function tokenStillAtRange(
  terminal: Terminal,
  entry: { selection: VerifiedPathSelection; marker?: IMarker; decoration?: IDecoration },
): boolean {
  try {
    // xterm disposes markers (and their decorations) when the coordinate itself
    // is invalidated, for example by a full display erase. Falling back to the
    // stored line in that case creates a zombie entry with no underline DOM.
    if (entry.marker?.isDisposed === true || entry.decoration?.isDisposed === true) return false;
    const markerLine = entry.marker && !entry.marker.isDisposed ? entry.marker.line : undefined;
    const absoluteLine = markerLine ?? entry.selection.bufferLine - 1;
    const line = terminal.buffer.active.getLine(absoluteLine);
    if (!line) return false;
    const { text, columns } = reconstructLine(readLineCells(line));
    const offset = columns.indexOf(entry.selection.startCol);
    if (offset < 0) return false;
    return text.slice(offset, offset + entry.selection.token.length) === entry.selection.token;
  } catch {
    // 버퍼 접근이 실패하면 표시를 유지한다 — 읽지 못한 것을 근거로 지우면
    // 정상 밑줄이 사라진다.
    return true;
  }
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
  type Entry = {
    selection: VerifiedPathSelection;
    decoration?: IDecoration;
    marker?: IMarker;
  };
  const scopes: Record<PathLinkScope, Entry[]> = { selection: [], point: [], screen: [] };
  const allEntries = () => PATH_LINK_SCOPES.flatMap((scope) => scopes[scope]);

  const disposeEntry = (entry: Entry) => {
    entry.decoration?.dispose();
    entry.marker?.dispose();
  };

  const disposeScope = (scope: PathLinkScope) => {
    for (const entry of scopes[scope]) disposeEntry(entry);
    scopes[scope] = [];
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
    setVerifiedSelections: (scope: PathLinkScope, selections: VerifiedPathSelection[]) => {
      disposeScope(scope);

      for (const sel of selections) {
        const entry: Entry = { selection: sel };
        scopes[scope].push(entry);
        // 한 데코레이션 실패가 나머지 검증 경로의 밑줄·클릭을 막지 않는다.
        try {
          // registerMarker(offset) 는 커서 절대 라인 기준 상대 오프셋에 마커를 단다.
          const buffer = terminal.buffer.active;
          const cursorAbsY = (buffer.baseY ?? 0) + (buffer.cursorY ?? 0); // 0-based 절대 라인
          const targetAbsY = sel.bufferLine - 1; // 0-based 절대 라인
          const offset = Math.trunc(targetAbsY - cursorAbsY);
          if (!Number.isFinite(offset)) continue;
          const m = terminal.registerMarker(offset);
          if (!m) continue; // 라인이 버퍼 밖이면 이 데코레이션만 생략.
          entry.marker = m;

          const width = Math.max(1, sel.endCol - sel.startCol + 1);
          const dec = terminal.registerDecoration({
            marker: m,
            x: Math.max(0, sel.startCol - 1), // 0-based 셀
            width,
          });
          if (!dec) continue;
          entry.decoration = dec;
          // 최초 렌더 + 이후 재렌더(스크롤/리사이즈)마다 스타일 보장.
          if (dec.element) styleEl(dec.element);
          dec.onRender((el) => styleEl(el));
        } catch (err) {
          console.warn("[pathLink] 밑줄 데코레이션 생성 실패:", err);
        }
      }
    },
    clear: (scope?: PathLinkScope) => {
      if (scope) {
        disposeScope(scope);
        return;
      }
      for (const each of PATH_LINK_SCOPES) disposeScope(each);
    },
    getCurrent: (scope?: PathLinkScope) =>
      (scope ? scopes[scope] : allEntries()).map((entry) => entry.selection),
    revalidate: () => {
      // 출력마다 불리는 경로다. 표시 중인 링크가 없으면 버퍼도 읽지 않는다.
      if (!PATH_LINK_SCOPES.some((scope) => scopes[scope].length > 0)) return 0;
      let dropped = 0;
      for (const scope of PATH_LINK_SCOPES) {
        scopes[scope] = scopes[scope].filter((entry) => {
          if (tokenStillAtRange(terminal, entry)) return true;
          disposeEntry(entry);
          dropped += 1;
          return false;
        });
      }
      return dropped;
    },
    getHit: (clientX: number, clientY: number) => {
      for (const entry of allEntries()) {
        const element = entry.decoration?.element;
        if (!element?.isConnected) continue;
        const rect = element.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return { selection: entry.selection, rect };
        }
      }
      return null;
    },
    activate: (sel: VerifiedPathSelection, action: PathLinkClickAction) => {
      switch (action) {
        case "osOpen":
          deps.onOsAction(sel.absPath, "open");
          return;
        case "osReveal":
          deps.onOsAction(sel.absPath, "reveal");
          return;
        case "changeDir":
          deps.onChangeDir(sel.absPath);
          return;
        case "viewer":
          deps.onOpenPath(sel.absPath);
          return;
      }
    },
  };
}
