/**
 * Pane / View 인스턴스 오버라이드 — 로컬 UI 상태 (localStorage).
 *
 * 구성(`settings.json`)이 아닌 UI 상태를 재시작 간 보존하기 위한 공간.
 * - Pane 오버라이드: 레이아웃 슬롯에 귀속 (예: ControlBar 모드)
 * - View 오버라이드: 슬롯 내 콘텐츠에 귀속 (예: 폰트 줌)
 *
 * 생명주기:
 * - pane 삭제 시 `clearAll(paneId)`
 * - view 타입 전환 시 `clearViewOverride(paneId)` (pane 오버라이드는 유지)
 * - 기동 정합성: `gcStale(aliveIds)` — 살아있지 않은 paneId 제거
 *
 * 해석 순서: profileDefaults → profile → pane override → view override
 */

import { create } from "zustand";
import type { ControlBarMode } from "./settings-store";

export const PANE_OVERRIDES_KEY = "laymux-pane-overrides";
export const VIEW_OVERRIDES_KEY = "laymux-view-overrides";

export interface PaneOverrides {
  controlBarMode?: ControlBarMode;
}

export interface ViewOverrides {
  /** TerminalView: Ctrl+Wheel로 조정된 폰트 크기. */
  fontSize?: number;
}

function loadMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function saveMap<T>(key: string, map: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

interface OverridesState {
  paneOverrides: Record<string, PaneOverrides>;
  viewOverrides: Record<string, ViewOverrides>;

  getPaneOverride: (paneId: string) => PaneOverrides | undefined;
  setPaneOverride: (paneId: string, patch: Partial<PaneOverrides>) => void;
  clearPaneOverride: (paneId: string) => void;

  getViewOverride: (paneId: string) => ViewOverrides | undefined;
  setViewOverride: (paneId: string, patch: Partial<ViewOverrides>) => void;
  clearViewOverride: (paneId: string) => void;

  /** pane 삭제 시 호출 — pane/view 오버라이드 동시 제거. */
  clearAll: (paneId: string) => void;

  /** 기동 시 살아있는 paneId 집합으로 stale 항목 제거. */
  gcStale: (aliveIds: Set<string>) => void;
}

export const useOverridesStore = create<OverridesState>()((set, get) => ({
  paneOverrides: loadMap<PaneOverrides>(PANE_OVERRIDES_KEY),
  viewOverrides: loadMap<ViewOverrides>(VIEW_OVERRIDES_KEY),

  getPaneOverride: (paneId) => get().paneOverrides[paneId],
  setPaneOverride: (paneId, patch) => {
    set((state) => {
      const merged: PaneOverrides = { ...state.paneOverrides[paneId], ...patch };
      const next = { ...state.paneOverrides, [paneId]: merged };
      saveMap(PANE_OVERRIDES_KEY, next);
      return { paneOverrides: next };
    });
  },
  clearPaneOverride: (paneId) => {
    set((state) => {
      if (!(paneId in state.paneOverrides)) return state;
      const next = { ...state.paneOverrides };
      delete next[paneId];
      saveMap(PANE_OVERRIDES_KEY, next);
      return { paneOverrides: next };
    });
  },

  getViewOverride: (paneId) => get().viewOverrides[paneId],
  setViewOverride: (paneId, patch) => {
    set((state) => {
      const merged: ViewOverrides = { ...state.viewOverrides[paneId], ...patch };
      const next = { ...state.viewOverrides, [paneId]: merged };
      saveMap(VIEW_OVERRIDES_KEY, next);
      return { viewOverrides: next };
    });
  },
  clearViewOverride: (paneId) => {
    set((state) => {
      if (!(paneId in state.viewOverrides)) return state;
      const next = { ...state.viewOverrides };
      delete next[paneId];
      saveMap(VIEW_OVERRIDES_KEY, next);
      return { viewOverrides: next };
    });
  },

  clearAll: (paneId) => {
    set((state) => {
      const nextPane = { ...state.paneOverrides };
      const nextView = { ...state.viewOverrides };
      let changed = false;
      if (paneId in nextPane) {
        delete nextPane[paneId];
        changed = true;
      }
      if (paneId in nextView) {
        delete nextView[paneId];
        changed = true;
      }
      if (!changed) return state;
      saveMap(PANE_OVERRIDES_KEY, nextPane);
      saveMap(VIEW_OVERRIDES_KEY, nextView);
      return { paneOverrides: nextPane, viewOverrides: nextView };
    });
  },

  gcStale: (aliveIds) => {
    set((state) => {
      const nextPane: Record<string, PaneOverrides> = {};
      const nextView: Record<string, ViewOverrides> = {};
      let paneChanged = false;
      let viewChanged = false;
      for (const [id, v] of Object.entries(state.paneOverrides)) {
        if (aliveIds.has(id)) nextPane[id] = v;
        else paneChanged = true;
      }
      for (const [id, v] of Object.entries(state.viewOverrides)) {
        if (aliveIds.has(id)) nextView[id] = v;
        else viewChanged = true;
      }
      if (!paneChanged && !viewChanged) return state;
      if (paneChanged) saveMap(PANE_OVERRIDES_KEY, nextPane);
      if (viewChanged) saveMap(VIEW_OVERRIDES_KEY, nextView);
      return {
        paneOverrides: paneChanged ? nextPane : state.paneOverrides,
        viewOverrides: viewChanged ? nextView : state.viewOverrides,
      };
    });
  },
}));
