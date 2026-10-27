import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { subscribeTaskStateRecovery } from "./task-state-recovery";
import { onTaskStateRefresh } from "./task-state-refresh";

let stop: () => void;
let unlisten: () => void;
const refreshed = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useWorkspaceStore.setState({ activeWorkspaceId: "one" });
  for (const [id, workspaceId] of [
    ["a", "one"],
    ["b", "two"],
  ])
    useTerminalStore
      .getState()
      .registerInstance({ id, workspaceId, profile: "wsl", syncGroup: "s" });
  refreshed.mockClear();
  unlisten = onTaskStateRefresh(refreshed);
  stop = subscribeTaskStateRecovery();
  refreshed.mockClear();
});
afterEach(() => {
  stop();
  unlisten();
  vi.useRealTimers();
});

it("workspace 진입과 Remote도 공유하는 pane focus에서 대상 상태를 다시 읽는다", () => {
  useWorkspaceStore.setState({ activeWorkspaceId: "two" });
  expect(refreshed).toHaveBeenLastCalledWith(["b"]);
  useTerminalStore.getState().updateInstanceInfo("b", { isFocused: true });
  expect(refreshed).toHaveBeenLastCalledWith(["b"]);
  refreshed.mockClear();
  useTerminalStore.getState().updateInstanceInfo("b", { outputActive: true });
  expect(refreshed).not.toHaveBeenCalled();
});

it("시간 경과만으로 전체 pane을 재조회하지 않고 foreground에서는 현재 workspace만 읽는다", async () => {
  await vi.advanceTimersByTimeAsync(180_000);
  expect(refreshed).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refreshed).toHaveBeenLastCalledWith(["a"]);
  stop();
  refreshed.mockClear();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refreshed).not.toHaveBeenCalled();
});
