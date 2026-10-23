import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { getSortedWorkspaces } from "./navigation-actions";
import { requestWorkspaceClose, restoreWorkspaceClose } from "./workspace-close";

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useUiStore.setState(useUiStore.getInitialState());
  useOverridesStore.setState(useOverridesStore.getInitialState());
  useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

it("닫기는 5초 동안 실제 workspace와 pane 상태를 보존하고 이동 후보에서 제외한다", () => {
  const ws = useWorkspaceStore.getState().workspaces[1];
  useOverridesStore.getState().setViewOverride(ws.panes[0].id, { fontSize: 20 });
  useWorkspaceStore.getState().setActiveWorkspace(ws.id);
  expect(requestWorkspaceClose(ws.id)).toBe(true);
  expect(useWorkspaceStore.getState().workspaces[1]).toBe(ws);
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  expect(getSortedWorkspaces().workspaces.map((item) => item.id)).toEqual(["ws-default"]);
  vi.advanceTimersByTime(4999);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
  expect(useOverridesStore.getState().getViewOverride(ws.panes[0].id)?.fontSize).toBe(20);
  vi.advanceTimersByTime(1);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
  expect(useOverridesStore.getState().getViewOverride(ws.panes[0].id)).toBeUndefined();
  expect(useWorkspaceStore.getState().pendingWorkspaceCloses).toEqual([]);
});

it("복원은 같은 ID와 상태를 유지하고 만료 타이머를 취소하며 포커스를 빼앗지 않는다", () => {
  const ws = useWorkspaceStore.getState().workspaces[1];
  requestWorkspaceClose(ws.id);
  vi.advanceTimersByTime(4000);
  expect(restoreWorkspaceClose(ws.id)).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(useWorkspaceStore.getState().workspaces[1]).toBe(ws);
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  expect(useWorkspaceStore.getState().pendingWorkspaceCloses).toEqual([]);
});

it("중복 요청은 만료를 연장하지 않고 마지막 표시 workspace를 보호한다", () => {
  const id = useWorkspaceStore.getState().workspaces[1].id;
  requestWorkspaceClose(id);
  const pending = useWorkspaceStore.getState().pendingWorkspaceCloses[0];
  vi.advanceTimersByTime(1000);
  expect(requestWorkspaceClose(id)).toBe(true);
  expect(useWorkspaceStore.getState().pendingWorkspaceCloses).toEqual([pending]);
  expect(requestWorkspaceClose("ws-default")).toBe(false);
  expect(requestWorkspaceClose("missing")).toBe(false);
  vi.advanceTimersByTime(4000);
  expect(restoreWorkspaceClose(id)).toBe(false);
});

it("연속 닫기의 만료와 복원을 각각 처리한다", () => {
  useWorkspaceStore.getState().addWorkspace("Third", "default-layout");
  const [, second, third] = useWorkspaceStore.getState().workspaces;
  requestWorkspaceClose(second.id);
  vi.advanceTimersByTime(1000);
  requestWorkspaceClose(third.id);
  vi.advanceTimersByTime(4000);
  expect(useWorkspaceStore.getState().workspaces.map((ws) => ws.id)).toEqual([
    "ws-default",
    third.id,
  ]);
  expect(restoreWorkspaceClose(third.id)).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
});

it("대기 workspace에는 직접 전환할 수 없고 새 요청에 이전 타이머가 간섭하지 않는다", () => {
  const id = useWorkspaceStore.getState().workspaces[1].id;
  requestWorkspaceClose(id);
  useWorkspaceStore.getState().setActiveWorkspace(id);
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  vi.advanceTimersByTime(3000);
  restoreWorkspaceClose(id);
  requestWorkspaceClose(id);
  vi.advanceTimersByTime(2000);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
  vi.advanceTimersByTime(3000);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
});
