import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorktreeSnapshot, inspectWorktree, type WorktreeSnapshot } from "./worktree-api";
import {
  clearWorktreeSnapshotCache,
  subscribeWorktreeCheck,
  worktreeCacheMetrics,
} from "./worktree-snapshot-cache";

vi.mock("./worktree-api", () => ({ getWorktreeSnapshot: vi.fn(), inspectWorktree: vi.fn() }));
const empty: WorktreeSnapshot = {
  workingDir: "D:/repo",
  repositoryPath: "D:/repo",
  commonDir: "D:/repo/.git",
  worktrees: [],
};
const subscribe = (target = "repo", signal = "initial", force = false) => {
  const listener = vi.fn();
  const stop = subscribeWorktreeCheck(target, signal, "D:/repo", undefined, force, listener);
  return { listener, stop };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
  vi.resetAllMocks();
  clearWorktreeSnapshotCache();
  vi.mocked(getWorktreeSnapshot).mockResolvedValue(empty);
});
afterEach(() => vi.useRealTimers());

describe("워크트리 검사 캐시", () => {
  it("30초 이내 완료 결과를 재사용하고 만료되면 다시 읽는다", async () => {
    subscribe().stop();
    await vi.runAllTimersAsync();
    subscribe();
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(1);
    expect(worktreeCacheMetrics().hits).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    subscribe();
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(2);
  });
  it("첫 화면이 사라져도 요청을 공유하고 응답은 남은 구독자에게만 보낸다", async () => {
    let resolve!: (value: WorktreeSnapshot) => void;
    vi.mocked(getWorktreeSnapshot).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = subscribe();
    first.stop();
    const second = subscribe();
    resolve(empty);
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(1);
    expect(first.listener).not.toHaveBeenCalled();
    expect(second.listener).toHaveBeenLastCalledWith({ snapshot: empty, inspections: {} });
    expect(inspectWorktree).not.toHaveBeenCalled();
  });
  it("원본 환경·사용 무효화·수동 새로고침을 분리한다", async () => {
    subscribe("ubuntu");
    subscribe("debian");
    subscribe("ubuntu", "restored");
    await vi.runAllTimersAsync();
    subscribe("ubuntu", "restored", true);
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(4);
  });
  it("조회 실패를 캐시하지 않고 재진입 때 복구한다", async () => {
    vi.mocked(getWorktreeSnapshot).mockRejectedValueOnce(new Error("배포판 조회 실패"));
    subscribe();
    await vi.runAllTimersAsync();
    const retry = subscribe();
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(2);
    expect(retry.listener).toHaveBeenLastCalledWith({ snapshot: empty, inspections: {} });
  });
  it("메모리에 보유하는 대상을 12개로 제한한다", async () => {
    for (let i = 0; i < 13; i++) subscribe(`repo-${i}`);
    await vi.runAllTimersAsync();
    expect(worktreeCacheMetrics().targets).toBe(12);
    subscribe("repo-0");
    await vi.runAllTimersAsync();
    expect(getWorktreeSnapshot).toHaveBeenCalledTimes(14);
  });
});
