/**
 * 1회성 CWD 전파 디스패치 (issue #293, #324).
 *
 * 컨트롤 바 버튼(`PaneGrid` → `PaneControlBar`)과 키바인딩
 * (`useKeyboardShortcuts`, `pane.propagateCwdOnce`)이 공유하는 단일 진입점.
 *
 * - TerminalView: 백엔드 PTY 세션이 있으므로 `propagate_cwd_once`(force) 커맨드를
 *   호출한다. terminal_id 는 ViewRenderer 와 동일한 `getInstanceId` 헬퍼로 만들어
 *   instanceId 규칙이 어긋나 `Session not found` 가 나는 일을 막는다.
 * - FileExplorerView: 백엔드 세션이 없어 커맨드가 `Session not found` 로 실패하므로,
 *   cwd 를 아는 view 자신이 force one-shot `sync-cwd` 를 디스패치하도록
 *   요청 버스(`cwd-propagate-store`)로 위임한다.
 */

import { propagateCwdOnce } from "@/lib/tauri-api";
import { useCwdPropagateStore } from "@/stores/cwd-propagate-store";
import { getInstanceId } from "@/lib/view-instance-id";
import type { ViewInstanceConfig } from "@/stores/types";

/**
 * 해당 pane 의 CWD 를 sync group 에 1회 전파한다.
 * CWD 를 갖지 않는 view(Memo 등)는 무시하고 `false` 를 반환한다.
 */
export function propagateCwdOnceForPane(pane: { id: string; view: ViewInstanceConfig }): boolean {
  if (pane.view.type === "FileExplorerView") {
    useCwdPropagateStore.getState().requestPropagate(pane.id);
    return true;
  }
  if (pane.view.type === "TerminalView") {
    const instanceId = getInstanceId("TerminalView", pane.id);
    propagateCwdOnce(instanceId).catch((err) => {
      console.warn(`[propagateCwdOnce] ${instanceId} 1회 전파 실패:`, err);
    });
    return true;
  }
  return false;
}
