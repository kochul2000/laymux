import { describe, expect, it } from "vitest";
import { commandStatusIconName } from "../remote/remote-icons.js";
import { observeTask, taskPolicy, taskPresentation, type TaskObservation } from "./terminal-task";
import { computeCommandStatus } from "./workspace-summary";

describe("터미널의 단일 상태 아이콘", () => {
  it.each([undefined, { type: "shell" } as const])(
    "에이전트 activity가 없는 미확인 셸은 출력만 표시하고 이전 exitCode로 성공을 합성하지 않는다 (%j)",
    (activity) => {
      for (const output of [false, true, false]) {
        const status = computeCommandStatus(0, output, undefined, activity);
        expect(status).toMatchObject({
          icon: output ? "⏳" : "—",
          observation: "unknown",
          outputActive: output,
        });
        expect(status.taskState).toBeUndefined();
        expect(status.taskResult).toBeUndefined();
        expect(commandStatusIconName(status)).toBe(output ? "Hourglass" : "Minus");
      }
    },
  );

  it.each([
    [undefined, undefined, false, "—", "Minus"],
    [undefined, undefined, true, "⏳", "Hourglass"],
    ["idle", undefined, false, "—", "Minus"],
    ["idle", undefined, true, "—", "Minus"],
    ["running", undefined, false, "⏳", "Hourglass"],
    ["running", undefined, true, "⏳", "Hourglass"],
    ["waiting", undefined, false, "!", "CircleAlert"],
    ["waiting", undefined, true, "!", "CircleAlert"],
    ["ended", "success", false, "✓", "Check"],
    ["ended", "success", true, "✓", "Check"],
    ["ended", "failure", true, "✗", "X"],
    ["ended", "interrupted", false, "—", "Minus"],
    ["ended", "interrupted", true, "—", "Minus"],
    ["ended", undefined, true, "—", "Minus"],
  ] as const)(
    "%s/%s, 출력 %s: Desktop과 Remote는 %s 하나를 표시한다",
    (state, result, output, glyph, icon) => {
      const task = observeTask(
        undefined,
        { source: "1:shell", taskId: "1", sequence: 1, state, result },
        100,
      );
      const before = structuredClone(task);
      const presentation = taskPresentation(task, 200, output);
      expect(presentation.icon).toBe(glyph);
      expect(
        commandStatusIconName({ taskState: state, taskResult: result, outputActive: output }),
      ).toBe(icon);
      expect(task).toEqual(before);
    },
  );

  it("관측 지연은 아이콘·접근성 이름을 바꾸지 않고 내부 보호와 알림 이력을 보존한다", () => {
    const input: TaskObservation = {
      source: "1:Codex",
      taskId: "1",
      sequence: 1,
      state: "running",
    };
    const running = observeTask(undefined, input, 100);
    const stale = observeTask(running, { ...input, sequence: 2, state: undefined }, 200);
    expect(taskPresentation(stale, 70_000)).toMatchObject({
      icon: "⏳",
      label: taskPresentation(running).label,
      observation: "stale",
    });
    expect(taskPolicy(stale, true, true, false, 70_000)).toMatchObject({
      clearAllowed: false,
      inhibitSleep: false,
    });
    const ended = observeTask(stale, { ...input, sequence: 3, state: "ended" }, 70_001);
    expect(ended.notification).toBe("ended");
    expect(taskPresentation(ended).icon).toBe("—");
    expect(
      observeTask(ended, { ...input, sequence: 4, state: "ended" }, 70_002).notificationId,
    ).toBe(ended.notificationId);
  });

  it("출력 모래시계는 작업 running을 합성하거나 에이전트 보호 정책을 바꾸지 않는다", () => {
    expect(taskPresentation(undefined, 100, true).icon).toBe("⏳");
    expect(taskPolicy(undefined, true, true, false, 100)).toMatchObject({
      state: undefined,
      observation: "unknown",
      clearAllowed: false,
      inhibitSleep: false,
    });
  });
});
