/**
 * 1회성 CWD 전파 요청 버스 (issue #293).
 *
 * file explorer 페인은 백엔드 PTY 세션이 없어 `propagate_cwd_once` 커맨드가
 * `Session not found` 로 실패한다. 대신 file explorer 는 자신이 알고 있는
 * `currentCwd` 를 force one-shot `sync-cwd` 로 직접 디스패치해야 한다.
 *
 * 컨트롤 바 버튼(`PaneGrid` → `PaneControlBar`)과 실제 cwd 를 아는
 * `FileExplorerView` 는 서로 다른 컴포넌트이므로, paneId 별 단조 증가 카운터를
 * 통해 버튼 클릭을 view 로 전달한다. 카운터가 바뀌면 view 가 1회 전파를 실행한다.
 *
 * 이 상태는 영속화하지 않는다(localStorage 사용 안 함) — 순수 휘발성 요청 신호.
 */

import { create } from "zustand";

interface CwdPropagateState {
  /** paneId → 전파 요청 횟수. 값이 증가하면 해당 페인의 view 가 1회 전파한다. */
  requests: Record<string, number>;
  /** 컨트롤 바 버튼이 호출 — 해당 paneId 의 요청 카운터를 1 증가시킨다. */
  requestPropagate: (paneId: string) => void;
  /** 페인 제거 시 요청 항목 정리. */
  clear: (paneId: string) => void;
}

export const useCwdPropagateStore = create<CwdPropagateState>((set) => ({
  requests: {},
  requestPropagate: (paneId) =>
    set((s) => ({
      requests: { ...s.requests, [paneId]: (s.requests[paneId] ?? 0) + 1 },
    })),
  clear: (paneId) =>
    set((s) => {
      if (!(paneId in s.requests)) return s;
      const next = { ...s.requests };
      delete next[paneId];
      return { requests: next };
    }),
}));
