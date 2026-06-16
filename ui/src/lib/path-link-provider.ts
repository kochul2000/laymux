/**
 * 터미널에서 사용자가 *선택(드래그)* 한 (상대/절대) 파일·디렉토리 경로에
 * 밑줄을 긋고, 클릭하면 파일은 viewer 로 열고 디렉토리는 cwd 로 전파하는
 * xterm.js ILinkProvider (issue #363, 선택 기반 재설계).
 *
 * 기존 동작(hover 줄 전체 토큰을 stat)을 제거했다. 새 동작:
 *   1. 호출부(TerminalView)가 선택 변경/드래그 종료 시점에 선택 문자열을
 *      순수 로직(`trimSelectionToPath`/`isWithinPathLengthLimit`)으로 거르고,
 *      cwd 와 조합(`joinCwdPath`)해 절대경로를 만든 뒤 **stat 을 선택당 1회만**
 *      호출한다. 존재하면 `setVerifiedSelection(...)` 으로 검증된 범위를 저장.
 *   2. 이 provider 의 `provideLinks` 는 저장된 검증 범위와 *겹치는 줄/컬럼*
 *      에 대해서만 ILink 를 돌려준다. **provideLinks 안에서는 stat 하지 않는다.**
 *   3. 클릭 시 `isDirectory` 에 따라 `onOpenPath`(파일) 또는 `onChangeDir`
 *      (디렉토리, cwd 전파)로 라우팅한다.
 *   4. 선택이 바뀌거나 해제되면 `clear()` 로 비우고 refresh 한다.
 *
 * 경로는 보통 한 줄이므로 단일 라인 케이스를 확실히 지원한다. 여러 줄에 걸친
 * 선택은 미지원이지만(첫 줄만 사용) 깨지지 않게 처리한다.
 */

import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from "@xterm/xterm";

/** 검증된 선택 경로의 버퍼 범위 + 메타. */
export interface VerifiedPathSelection {
  /** 1-based 버퍼 라인(절대 y). 단일 라인 가정. */
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

export interface PathLinkProviderDeps {
  /** 검증된 파일 경로 클릭 시 호출 — viewer 로 연다. */
  onOpenPath: (absPath: string) => void;
  /** 검증된 디렉토리 경로 클릭 시 호출 — 해당 경로로 cwd 전파. */
  onChangeDir: (absPath: string) => void;
}

/**
 * 선택 기반 path-link provider 와 그 검증 상태 컨트롤러를 만든다.
 *
 * 반환값:
 *   - `provider`: xterm 에 등록할 ILinkProvider.
 *   - `setVerifiedSelection(sel)`: 검증된 선택 범위를 저장.
 *   - `clear()`: 저장 상태를 비운다(선택 해제/변경 시).
 *   - `getCurrent()`: 현재 검증 상태(테스트/디버그용).
 */
export function createPathLinkProvider(
  _terminal: Terminal,
  deps: PathLinkProviderDeps,
): {
  provider: ILinkProvider;
  setVerifiedSelection: (sel: VerifiedPathSelection) => void;
  clear: () => void;
  getCurrent: () => VerifiedPathSelection | null;
} {
  let current: VerifiedPathSelection | null = null;

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const sel = current;
      // 검증된 선택이 없거나, 이 줄이 그 선택의 줄이 아니면 링크 없음.
      if (!sel || sel.bufferLine !== bufferLineNumber) {
        callback(undefined);
        return;
      }

      const start: IBufferCellPosition = { x: sel.startCol, y: bufferLineNumber };
      const end: IBufferCellPosition = { x: sel.endCol, y: bufferLineNumber };
      const absPath = sel.absPath;
      const isDirectory = sel.isDirectory;
      callback([
        {
          range: { start, end },
          text: absPath,
          activate: () => {
            if (isDirectory) deps.onChangeDir(absPath);
            else deps.onOpenPath(absPath);
          },
        },
      ]);
    },
  };

  return {
    provider,
    setVerifiedSelection: (sel: VerifiedPathSelection) => {
      current = sel;
    },
    clear: () => {
      current = null;
    },
    getCurrent: () => current,
  };
}
