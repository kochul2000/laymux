import { describe, expect, it } from "vitest";
import { observeTask, taskPolicy, type TaskObservation } from "./terminal-task";

const running: TaskObservation = {
  source: "1:Codex:s",
  taskId: "turn-1",
  sequence: 1,
  state: "running",
};

describe("ADR-0250 작업 상태", () => {
  it.each(["success", "failure", "interrupted", undefined] as const)(
    "최초 종료(%s)는 무알림 복원하고 결과 보강도 다시 알리지 않는다",
    (result) => {
      const first = observeTask(undefined, { ...running, state: "ended", result }, 0);
      expect(first.notification).toBeUndefined();
      expect(
        observeTask(first, { ...running, sequence: 2, state: "ended", result: "success" }, 1)
          .notification,
      ).toBeUndefined();
    },
  );

  it("최초 입력 대기는 무알림, 해소 뒤 재진입은 한 번 알린다", () => {
    const waiting = observeTask(undefined, { ...running, state: "waiting" }, 0);
    expect(waiting.notification).toBeUndefined();
    const resumed = observeTask(
      waiting,
      { ...running, sequence: 2, state: "running", resolvesWaiting: true },
      1,
    );
    const next = observeTask(resumed, { ...running, sequence: 3, state: "waiting" }, 2);
    expect(next.notification).toBe("waiting");
    expect(observeTask(next, { ...running, sequence: 4, state: "waiting" }, 3).notificationId).toBe(
      next.notificationId,
    );
  });

  it("조회 실패는 이력을 보존하며 복구 종료는 한 번 알린다", () => {
    const active = observeTask(undefined, running, 100);
    const stale = observeTask(active, { ...running, sequence: 2, state: undefined }, 200);
    expect(stale).toMatchObject({ state: "running", observation: "stale", lastRunningAt: 100 });
    const ended = observeTask(stale, { ...running, sequence: 3, state: "ended" }, 300);
    expect(ended.notification).toBe("ended");
    expect(ended.result).toBeUndefined();
    expect(
      observeTask(ended, { ...running, sequence: 4, state: "ended" }, 400).notificationId,
    ).toBe(ended.notificationId);
  });

  it("대기 우선순위, 닫힌 작업의 늦은 대기와 오래된 순서를 검증한다", () => {
    const active = observeTask(undefined, running, 0);
    const waiting = observeTask(active, { ...running, sequence: 3, state: "waiting" }, 1);
    expect(observeTask(waiting, { ...running, sequence: 4 }, 2).state).toBe("waiting");
    expect(observeTask(waiting, { ...running, sequence: 2, state: "ended" }, 2)).toBe(waiting);
    const ended = observeTask(waiting, { ...running, sequence: 5, state: "ended" }, 3);
    expect(observeTask(ended, { ...running, sequence: 6, state: "waiting" }, 4).state).toBe(
      "ended",
    );
  });

  it("새 관측 대상의 종료와 입력 대기는 이전 작업의 알림을 상속하지 않는다", () => {
    const active = observeTask(undefined, running, 0);
    expect(
      observeTask(active, { ...running, source: "2:Codex:new", state: "ended" }, 1).notification,
    ).toBeUndefined();
    expect(
      observeTask(active, { ...running, source: "2:Codex:new", state: "waiting" }, 1).notification,
    ).toBeUndefined();
  });

  it("이전 턴과 이전 세션에 속한 늦은 입력 관측을 거부한다", () => {
    const active = observeTask(undefined, running, 0);
    expect(
      observeTask(
        active,
        { ...running, kind: "input", sequence: 2, taskId: "old", state: "waiting" },
        1,
      ),
    ).toBe(active);
    expect(
      observeTask(
        active,
        { ...running, kind: "input", sequence: 2, source: "old", state: "waiting" },
        1,
      ),
    ).toBe(active);
  });

  it("6초 타이틀 만료와 60초 절전 상한은 clear를 허용하지 않는다", () => {
    const active = observeTask(undefined, { ...running, expiresAfter: 6000 }, 100);
    expect(taskPolicy(active, false, true, false, 6099)).toMatchObject({
      observation: "confirmed",
      inhibitSleep: true,
    });
    expect(taskPolicy(active, true, true, false, 6100)).toMatchObject({
      observation: "stale",
      inhibitSleep: true,
      clearAllowed: false,
    });
    expect(taskPolicy(active, true, true, false, 60100)).toMatchObject({
      inhibitSleep: false,
      clearAllowed: false,
      sleepExpired: true,
    });
  });

  it("비통합 셸만 출력 절전 및 확인된 liveness clear 예외를 사용한다", () => {
    expect(taskPolicy(undefined, true, false, true, 0)).toMatchObject({
      observation: "unknown",
      inhibitSleep: true,
      clearAllowed: false,
    });
    expect(taskPolicy(undefined, false, false, true, 0).clearAllowed).toBe(true);
    expect(taskPolicy(undefined, false, false, false, 0).clearAllowed).toBe(false);
    expect(taskPolicy(undefined, true, true, true, 0).inhibitSleep).toBe(false);
  });
});
