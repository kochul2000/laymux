/**
 * 터미널 출력의 (상대/절대) 파일 경로를 hover 시 검증해 밑줄을 긋고,
 * 클릭하면 viewer 로 여는 xterm.js ILinkProvider (issue #363).
 *
 * 기존 URL 링크는 `indented-link-provider.ts`(들여쓰기 하드랩 URL)와
 * WebLinksAddon 이 담당한다. 이 provider 는 그 옆에서 "스킴 없는 파일 경로"
 * 만 추가로 처리한다. 경로 판별 휴리스틱과 cwd 조합은 순수 모듈
 * `path-link-detect.ts` 에 있고, 여기서는 xterm 버퍼 접근 + 비동기 검증
 * 캐시 + 링크 등록을 담당한다.
 *
 * 동작:
 *   1. provideLinks 에서 해당 줄의 경로 후보를 모두 추출.
 *   2. 각 후보를 cwd 와 조합해 절대 경로를 만든다.
 *   3. 절대 경로의 존재 여부를 캐시에서 조회.
 *      - 캐시에 "존재함" → 링크 등록(밑줄 + 클릭 가능).
 *      - 캐시에 "없음" → 링크 미등록(밑줄 없음).
 *      - 캐시 미스 → 비동기 검증 시작, 결과 도착 시 onValidated 로
 *        재렌더(terminal.refresh)를 유도. 이번 호출에서는 미등록.
 *
 * xterm 의 ILinkProvider.provideLinks 는 동기 콜백이라 검증 결과를
 * 그 자리에서 기다릴 수 없다. 그래서 검증 결과를 캐시하고, 검증이 끝나면
 * 호출자가 해당 줄을 refresh 하게 해서(다음 hover/refresh 때) 밑줄이 뜬다.
 */

import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from "@xterm/xterm";
import { findPathCandidatesInLine, joinCwdPath } from "./path-link-detect";

/** 절대 경로 검증 함수: 존재하면 true. (백엔드 stat_path 래퍼 주입) */
export type PathValidator = (absPath: string) => Promise<boolean>;

export interface PathLinkProviderDeps {
  /** 현재 터미널 pane 의 cwd 를 반환. 없으면 undefined. */
  getCwd: () => string | undefined;
  /** 절대 경로 존재 검증(비동기). */
  validate: PathValidator;
  /** 검증된(존재하는) 경로를 클릭했을 때 호출 — viewer 로 연다. */
  onOpenPath: (absPath: string) => void;
  /** 기능 on/off (설정 연동). 매 호출마다 확인해 즉시 반영. */
  isEnabled?: () => boolean;
  /** 비동기 검증이 완료돼 캐시가 갱신됐을 때 호출(예: terminal.refresh). */
  onValidated?: () => void;
}

/** 검증 캐시 상태. */
type CacheState = "valid" | "invalid" | "pending";

/**
 * 절대 경로 검증 결과를 캐시한다. provideLinks 가 동기 콜백이므로,
 * 비동기 검증 결과를 여기 모았다가 다음 렌더에서 반영한다.
 */
export class PathValidationCache {
  private cache = new Map<string, CacheState>();

  constructor(private validate: PathValidator) {}

  /** 현재 캐시 상태(미조회면 undefined). */
  get(absPath: string): CacheState | undefined {
    return this.cache.get(absPath);
  }

  /**
   * 검증을 보장한다. 미조회면 pending 으로 표시하고 비동기 검증을 시작,
   * 결과 도착 시 onDone 을 부른다. 이미 결과/진행 중이면 아무것도 안 한다.
   * @returns 현재 알려진 상태(검증을 새로 시작했으면 "pending").
   */
  ensure(absPath: string, onDone: () => void): CacheState {
    const existing = this.cache.get(absPath);
    if (existing) return existing;
    this.cache.set(absPath, "pending");
    this.validate(absPath)
      .then((exists) => {
        this.cache.set(absPath, exists ? "valid" : "invalid");
        onDone();
      })
      .catch(() => {
        // 검증 실패는 "없음"으로 취급(밑줄 안 긋고 조용히 무시).
        this.cache.set(absPath, "invalid");
        onDone();
      });
    return "pending";
  }
}

/**
 * path link provider 를 만든다.
 */
export function createPathLinkProvider(
  terminal: Terminal,
  deps: PathLinkProviderDeps,
): ILinkProvider {
  const cache = new PathValidationCache(deps.validate);

  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      if (deps.isEnabled && !deps.isEnabled()) {
        callback(undefined);
        return;
      }

      const cwd = deps.getCwd();
      const bufLine = terminal.buffer.active.getLine(bufferLineNumber - 1); // 0-based
      if (!bufLine) {
        callback(undefined);
        return;
      }
      const lineText = bufLine.translateToString();

      const candidates = findPathCandidatesInLine(lineText);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      for (const cand of candidates) {
        const absPath = joinCwdPath(cwd, cand.text);
        if (!absPath) continue; // 상대경로인데 cwd 가 없으면 검증 불가 → 스킵.

        const state = cache.get(absPath) ?? cache.ensure(absPath, () => deps.onValidated?.());
        if (state !== "valid") continue; // 유효할 때만 밑줄/클릭 활성화.

        const start: IBufferCellPosition = { x: cand.startCol, y: bufferLineNumber };
        const end: IBufferCellPosition = { x: cand.endCol, y: bufferLineNumber };
        links.push({
          range: { start, end },
          text: cand.text,
          activate: () => deps.onOpenPath(absPath),
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
