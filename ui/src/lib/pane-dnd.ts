/**
 * Shared HTML5 DnD payload for dragging a pane (issue #377 swap, issue #380 move).
 *
 * The same drag source (PaneGrid 컨트롤바의 드래그 핸들) feeds two drop targets:
 *  - 같은 그리드의 다른 pane → 위치 교환(swap, workspace-store.swapPanes)
 *  - WorkspaceSelectorView 의 워크스페이스 항목 → 그 워크스페이스로 이동(move,
 *    workspace-store.movePaneToWorkspace)
 *
 * dataTransfer 에 paneId 만 실으면 충분하다. 소스 워크스페이스는 paneId 로 조회 가능하고
 * (workspace-store.movePaneToWorkspace), swap 은 같은 그리드 안이라 워크스페이스가 동일하다.
 */
export const PANE_DND_MIME = "application/x-laymux-pane";

/** dataTransfer 에 드래그 중인 paneId 를 기록한다. */
export function setPaneDragData(e: React.DragEvent, paneId: string): void {
  e.dataTransfer.setData(PANE_DND_MIME, paneId);
  e.dataTransfer.effectAllowed = "move";
}

/** dataTransfer 에서 드래그 중인 paneId 를 읽는다. 없으면 null. */
export function getPaneDragData(e: React.DragEvent): string | null {
  return e.dataTransfer.getData(PANE_DND_MIME) || null;
}

/**
 * 현재 드래그가 pane 드래그인지 판정한다.
 * dragover/drop 시점에는 보안상 getData 가 빈 문자열을 돌려줄 수 있으므로 `types` 로 판정한다.
 * (`types` 는 브라우저에서 항상 제공되지만, 일부 테스트 스텁에는 없을 수 있어 방어한다.)
 */
export function isPaneDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types?.includes(PANE_DND_MIME) ?? false;
}
