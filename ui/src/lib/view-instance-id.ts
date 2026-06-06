import type { ViewType } from "@/stores/types";

/**
 * cwd 를 가질 수 있는(백엔드 세션/sync group 에 참여하는) view 타입의 instanceId prefix.
 *
 * instanceId 규칙은 ViewRenderer(렌더링)와 PaneGrid(1회성 CWD 전파 버튼)가 함께
 * 의존한다(issue #293). prefix 가 두 곳에서 어긋나면 백엔드 terminal_id 불일치로
 * `Session not found` 가 발생하므로, 매핑은 반드시 이 한곳에서만 정의한다.
 *
 * 새 cwd-bearing view 를 추가하면 여기 prefix 를 등록한다. 등록되지 않은 타입은
 * `getInstanceId` 가 명시적으로 거부한다(암묵적 fallback prefix 없음).
 */
const VIEW_INSTANCE_PREFIX: Partial<Record<ViewType, string>> = {
  TerminalView: "terminal",
  FileExplorerView: "file-explorer",
};

/**
 * 주어진 view 타입의 instanceId prefix 를 반환한다. cwd 를 갖지 않는(prefix 미등록)
 * 타입이면 `undefined`.
 */
export function getInstanceIdPrefix(viewType: ViewType): string | undefined {
  return VIEW_INSTANCE_PREFIX[viewType];
}

/**
 * view 타입과 식별자로 백엔드/이벤트에서 쓰는 instanceId 를 만든다.
 *
 * `id` 는 보통 paneId. pane 에 속하지 않은 렌더링(예: dock, 미리보기)에서는
 * 호출부가 안정적인 fallback id(`useId()` 등)를 넘긴다.
 *
 * prefix 가 등록되지 않은 view 타입(cwd 비대상)에는 instanceId 개념이 없으므로
 * 호출을 막기 위해 throw 한다 — 조용한 잘못된 id 생성보다 빠른 실패가 낫다.
 */
export function getInstanceId(viewType: ViewType, id: string): string {
  const prefix = getInstanceIdPrefix(viewType);
  if (prefix === undefined) {
    throw new Error(`getInstanceId: '${viewType}' 는 instanceId 를 갖지 않는 view 타입입니다`);
  }
  return `${prefix}-${id}`;
}
