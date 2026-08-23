/**
 * 포인터 지점 하나를 path-link 후보로 평가하는 컨트롤러(ADR-0188 `point` 트리거).
 *
 * 트리거는 세 가지 — 데스크톱의 hover dwell, 이동 없는 클릭, Remote 의 단일 탭
 * (Remote 는 host bridge 를 거쳐 같은 파서를 쓴다). 어느 쪽이든 **포인터 아래
 * 지점을 덮는 상수 개 후보**(maximal token 1 + 공백 확장 접두 ≤ 8, ADR-0191)만
 * 만들어 트리거당 `stat_paths` 를 정확히 배치 1건으로 묶는다. 과거 hover 발견이
 * 제거된 이유는 트리거가 아니라 "줄 전체 토큰마다 조회"였다(ADR-0148 Context)
 * — 그 실패 모드를 다시 만들지 않는 것이 이 모듈의 계약이다.
 *
 * 부수효과(밑줄 그리기·설정 읽기·버퍼 읽기·IPC)는 전부 주입받아 단위 테스트로
 * 덮는다. `TerminalView` 는 배선만 한다.
 */

import {
  decidePathLinkAction,
  extractPathCandidatesAtOffset,
  joinCwdPath,
  mapLineCandidateToPathRange,
  pathPointLimits,
  resolveOverlappingRanges,
} from "./path-link-detect";
import type { VerifiedPathSelection } from "./path-link-provider";
import { reconstructLine, type CellInfo } from "./terminal-cell-map";

/**
 * hover 가 "멈췄다"고 볼 시간(ms). 읽는 동안 포인터가 지나가는 토큰마다
 * 조회가 생기지 않을 만큼 길고, 멈춘 뒤 기다린다는 느낌이 나지 않을 만큼 짧게.
 */
export const PATH_LINK_HOVER_DWELL_MS = 300;

export interface PathLinkPointDeps {
  /** `terminal.pathLinkEnabled` 와 `terminal.pathLinkMaxLength`. */
  getSettings: () => { enabled: boolean; maxPathLength: number };
  /** pane 의 현재 cwd(상대경로 조합용). */
  getCwd: () => string | undefined;
  /** 화면 좌표 → 1-based 컬럼 + 0-based 절대 버퍼 라인. 실패하면 null. */
  resolveCell: (clientX: number, clientY: number) => { col: number; absoluteLine: number } | null;
  /** 0-based 절대 버퍼 라인의 셀. 없으면 null. */
  readLine: (absoluteLine: number) => CellInfo[] | null;
  /** bounded batch stat(트리거당 배치 1건, 후보 상수 개 — ADR-0191). */
  statPaths: (paths: string[]) => Promise<Array<{ exists: boolean; isDirectory: boolean }>>;
  /** 이미 검증된 밑줄 위인지 — 그러면 재평가하지 않는다. */
  isVerifiedAt: (clientX: number, clientY: number) => boolean;
  /** `point` scope 밑줄 교체(빈 배열이면 해제). */
  apply: (selections: VerifiedPathSelection[]) => void;
}

export interface PathLinkPointEvaluator {
  /** 그 지점을 평가한다. stat 배치는 최대 1건이고, 조건에 걸리면 0건이다. */
  evaluateAt: (clientX: number, clientY: number) => Promise<void>;
  /**
   * 진행 중 결과와 재조회 방지 memo 를 폐기한다. 선택 발생처럼 이 지점의
   * 평가 자체가 무의미해진 사건에서 호출한다.
   */
  invalidate: () => void;
  /**
   * 재조회 방지 memo 만 잊는다(진행 중 조회는 살린다). 출력이 도착해 화면 내용이
   * 달라질 수 있는 사건에서 호출한다 — 여기서 진행 중 조회까지 죽이면 출력이
   * 잦은 pane 에서 hover 가 밑줄을 영원히 못 켠다.
   */
  forget: () => void;
}

/** 1-based 컬럼을 덮는 UTF-16 offset. 없으면 -1. */
function offsetAtColumn(columns: number[], endColumns: number[], col: number): number {
  for (let offset = 0; offset < columns.length; offset++) {
    if (columns[offset] <= col && col <= endColumns[offset]) return offset;
  }
  return -1;
}

export function createPathLinkPointEvaluator(deps: PathLinkPointDeps): PathLinkPointEvaluator {
  // 마지막으로 평가를 끝낸 지점의 키. 성공(밑줄 켜짐)이든 실패(존재하지 않음)든
  // 같은 키는 다시 조회하지 않는다 — 포인터가 한 토큰 안에서 떠는 것으로는
  // filesystem 조회가 생기지 않는다.
  let evaluatedKey: string | null = null;
  // 지금 stat 이 도는 중인 지점. 같은 지점의 중복 배치를 막는다.
  let pendingKey: string | null = null;
  let revision = 0;

  // 표시를 비우는 것은 진행 중 조회도 무의미하게 만든다(포인터가 다른 곳으로
  // 갔거나 기능이 꺼졌다) → revision 을 올려 늦은 결과를 버린다.
  const clearPoint = () => {
    revision += 1;
    evaluatedKey = null;
    pendingKey = null;
    deps.apply([]);
  };

  /**
   * memo 만 잊는다(revision 은 그대로). 출력이 화면을 바꿨으면 같은 지점의
   * 음성 결과도 더 이상 유효하지 않지만, 진행 중인 조회를 죽이면 출력이 잦은
   * pane 에서 hover 가 영원히 밑줄을 못 켠다.
   */
  const forget = () => {
    evaluatedKey = null;
  };

  return {
    invalidate: () => {
      revision += 1;
      evaluatedKey = null;
      pendingKey = null;
    },
    forget,
    evaluateAt: async (clientX: number, clientY: number) => {
      const settings = deps.getSettings();
      if (!settings.enabled) {
        clearPoint();
        return;
      }
      // 이미 밑줄이 켜진 지점은 클릭 대상이 이미 있다 — 재파싱할 이유가 없다.
      if (deps.isVerifiedAt(clientX, clientY)) return;

      const cell = deps.resolveCell(clientX, clientY);
      if (!cell) {
        clearPoint();
        return;
      }
      const cells = deps.readLine(cell.absoluteLine);
      if (!cells || cells.length === 0) {
        clearPoint();
        return;
      }
      const { text, columns, endColumns } = reconstructLine(cells);
      const offset = offsetAtColumn(columns, endColumns, cell.col);
      if (offset < 0) {
        clearPoint();
        return;
      }
      const candidates = extractPathCandidatesAtOffset(
        text,
        offset,
        pathPointLimits(settings.maxPathLength),
      );
      if (candidates.length === 0) {
        clearPoint();
        return;
      }
      const cwd = deps.getCwd();
      const uniquePaths: string[] = [];
      const pathIndexes = new Map<string, number>();
      const pending = candidates.flatMap((candidate) => {
        const absPath = joinCwdPath(cwd, candidate.text);
        if (!absPath) return [];
        let statIndex = pathIndexes.get(absPath);
        if (statIndex === undefined) {
          statIndex = uniquePaths.length;
          pathIndexes.set(absPath, statIndex);
          uniquePaths.push(absPath);
        }
        return [{ candidate, absPath, statIndex }];
      });
      if (pending.length === 0) {
        clearPoint();
        return;
      }

      const key = `${cwd ?? ""}\u0000${cell.absoluteLine}\u0000${pending
        .map(({ candidate }) => `${candidate.startIndex}\u0000${candidate.text}`)
        .join("\u0001")}`;
      // 구분자는 반드시 \u0000/\u0001 **이스케이프**로 쓴다 — 생 제어 바이트를
      // 소스에 박으면 git 이 이 파일을 바이너리로 분류해 diff·grep 이 죽는다.
      // 키에 후보 집합 전체가 들어가므로 줄 꼬리가 바뀌어 확장 후보(ADR-0191)가
      // 달라지면 재평가된다.
      // 조회가 끝난 지점(성공·실패)과 지금 조회 중인 지점 둘 다 재조회를 막는다.
      // pendingKey 가 없으면 느린 stat 이 도는 동안 dwell 이 같은 토큰에 대해
      // 300ms 마다 새 배치를 계속 만든다.
      if (key === evaluatedKey || key === pendingKey) return;
      pendingKey = key;
      // 여기서부터가 실제 조회다 — revision 은 이 시점에만 올린다.
      const seq = ++revision;

      let infos: Array<{ exists: boolean; isDirectory: boolean }>;
      try {
        infos = await deps.statPaths(uniquePaths);
      } catch {
        if (pendingKey === key) pendingKey = null;
        if (seq === revision) clearPoint();
        return;
      }
      if (pendingKey === key) pendingKey = null;
      // 출력·선택 같은 사건이 끼면 이 결과는 화면과 맞지 않는다. cwd 가 바뀌면
      // 조합했던 절대 경로 자체가 다른 pane 맥락의 것이 된다(선택 경로의
      // `isPathLinkCwdCurrent` 가드와 같은 이유).
      if (seq !== revision || deps.getCwd() !== cwd) return;

      // 성공이든 실패든 이 지점은 평가가 끝났다 — 같은 지점 재조회를 막는다.
      evaluatedKey = key;
      const verified = pending.flatMap(({ candidate, absPath, statIndex }) => {
        const info = infos[statIndex];
        const action = info ? decidePathLinkAction(info) : "none";
        if (action === "none") return [];
        return [{ candidate, absPath, isDirectory: action === "changeDir" }];
      });
      // 지점을 덮는 후보들은 서로 겹치므로 존재하는 것 중 가장 긴 하나만
      // 남는다(ADR-0191 longest-existing-wins).
      const resolved = resolveOverlappingRanges(verified, ({ candidate }) => ({
        line: candidate.lineIndex,
        start: candidate.startIndex,
        end: candidate.endIndex,
      }));
      if (resolved.length === 0) {
        deps.apply([]);
        return;
      }
      deps.apply(
        resolved.map(({ candidate, absPath, isDirectory }) => ({
          ...mapLineCandidateToPathRange(cell.absoluteLine + 1, candidate, cells),
          absPath,
          token: candidate.text,
          isDirectory,
        })),
      );
    },
  };
}
