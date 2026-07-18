import { createContext, useContext, type ReactNode } from "react";
import type { ControlBarMode } from "./PaneControlBar";

/**
 * 터미널 입력 방식(direct/composer) 툴바 토글 상태. TerminalView 가 자신의 런타임
 * 모드와 토글 핸들러를 주입하면 PaneControlBar 가 단일 버튼으로 렌더한다(좁은 pane 은
 * ⋯ 메뉴로 자동 미러). 하단 컴포저 바에는 더 이상 모드 토글을 두지 않는다.
 */
export interface PaneInputModeToggle {
  mode: "direct" | "composer";
  onToggle: () => void;
}

export interface PaneControlContextValue {
  /** BarContent 렌더 결과 (split, delete, view selector 등) */
  paneControls: ReactNode;
  /**
   * 좌측(pane 번호 배지 우측)에 정렬되는 pane 컨트롤 (issue #324).
   * 현재는 "propagate CWD once" 버튼. ViewHeader 를 쓰는 View(FileExplorer 등)는
   * `paneControls` 와 같은 가시성 조건으로 배지 바로 다음에 렌더해야 한다.
   */
  leftPaneControls?: ReactNode;
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
   * 터미널 입력 방식 툴바 토글. TerminalView 가 주입하며 없으면 버튼을 렌더하지 않는다.
   */
  inputModeToggle: PaneInputModeToggle | null;
  /** 입력 방식 토글 설정/해제. `null` 이면 버튼 제거. */
  setInputModeToggle: (toggle: PaneInputModeToggle | null) => void;
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
  /**
   * pane 위치 교환 드래그 속성(issue #386). ViewHeader 를 쓰는 View 가 자신의 바
   * 컨테이너에 펼쳐(`{...barDragProps}`) 빈 영역 드래그로 swap 을 시작하게 한다.
   * dnd 비활성이면 빈 객체.
   */
  barDragProps?: {
    draggable?: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
  };
}

export const PaneControlContext = createContext<PaneControlContextValue | null>(null);

export function usePaneControl(): PaneControlContextValue | null {
  return useContext(PaneControlContext);
}
