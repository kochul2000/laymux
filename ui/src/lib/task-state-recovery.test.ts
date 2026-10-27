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

it("출력과 진입이 없어도 60초마다 모든 pane을 다시 읽고 dispose 후 멈춘다", async () => {
  await vi.advanceTimersByTimeAsync(59_999);
  expect(refreshed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(refreshed).toHaveBeenLastCalledWith(["a", "b"]);
  stop();
  refreshed.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(refreshed).not.toHaveBeenCalled();
});
