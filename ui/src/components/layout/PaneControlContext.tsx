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
  /** ViewHeader가 마운트되면 호출 — PaneControlBar 자체 바 렌더 억제 */
  registerHeader: () => void;
  /** ViewHeader가 언마운트되면 호출 */
  unregisterHeader: () => void;
}

export const PaneControlContext = createContext<PaneControlContextValue | null>(null);

export function usePaneControl(): PaneControlContextValue | null {
  return useContext(PaneControlContext);
}
