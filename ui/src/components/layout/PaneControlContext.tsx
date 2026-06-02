import { createContext, useContext, type ReactNode } from "react";
import type { ControlBarMode } from "./PaneControlBar";

export interface PaneControlContextValue {
  /** BarContent 렌더 결과 (split, delete, view selector 등) */
  paneControls: ReactNode;
  /** 현재 컨트롤 바 모드 */
  mode: ControlBarMode;
  /** Pane이 hover 상태인지 */
  hovered: boolean;
  /** 모드 변경 */
  onSetMode: (m: ControlBarMode) => void;
  /** Open the floating controls menu when controls are collapsed. */
  openControls?: () => void;
  /** ViewHeader가 마운트되면 호출 — PaneControlBar 자체 바 렌더 억제 */
  registerHeader: () => void;
  /** ViewHeader가 언마운트되면 호출 */
  unregisterHeader: () => void;
  /**
   * 자식 View 가 PaneControlBar 좌측 공간(기본 `BarLabel` 자리)에 주입할 콘텐츠.
   * View 라벨이 없는 타입(TerminalView 등)에서 pinned 바의 빈 좌측을 활용해
   * title/CWD/branch 같은 요약 정보를 표시하기 위한 슬롯이다.
   *
   * 주입해도 바 자체의 가시성(mode/hovered)은 바뀌지 않는다 — bar가 안 보이는
   * 상태에서는 주입된 노드도 렌더되지 않는다.
   */
  leftBarContent: ReactNode;
  /** 좌측 슬롯 콘텐츠 설정/해제. `null` 이면 기본 스페이서로 복귀. */
  setLeftBarContent: (node: ReactNode) => void;
  /**
   * 화면 읽기 순서 기반 pane 번호(issue #256). 컨트롤바 좌측에 배지로 표시한다.
   * 배열 인덱스(`paneIndex`)가 아니라 공간 위치 번호(`paneNumber`)이며, dock 등
   * 번호가 없는 경우 `undefined`.
   */
  paneNumber?: number;
  /**
   * 배지 클릭 시 복사할 식별자에 포함할 workspace id(issue #276). 없으면 배지는
   * 비대화형 라벨로만 렌더된다(복사 불가). `workspaceName`은 사람이 읽기 쉬운 힌트.
   */
  workspaceId?: string;
  workspaceName?: string;
}

export const PaneControlContext = createContext<PaneControlContextValue | null>(null);

export function usePaneControl(): PaneControlContextValue | null {
  return useContext(PaneControlContext);
}
