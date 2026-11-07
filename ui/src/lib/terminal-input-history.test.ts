import { beforeEach, expect, it } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { selectTerminalLastInput } from "./terminal-last-input";
import {
  captureInputHistoryScope,
  clearTerminalInputHistory,
  recordTerminalInput,
  correctTerminalInputFromAgent,
  correctTerminalInputFromScreen,
  noteTerminalInputSubmission,
} from "./terminal-input-history";

beforeEach(() => {
  useTerminalStore.setState(useTerminalStore.getInitialState());
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "t", profile: "test", syncGroup: "ws", workspaceId: "ws" });
  store.updateInstanceInfo("t", { generation: 1, lastCommand: "old command", lastCommandAt: 10 });
});
const current = () => useTerminalStore.getState().instances[0];

it.each(["clear", " cls ", "Clear-Host", "/clear"])(
  "%s clears history independently of activity",
  (text) => {
    for (const activity of [
      { type: "unknown" as const },
      { type: "interactiveApp" as const, name: "other" },
      { type: "running" as const },
    ]) {
      useTerminalStore.getState().updateInstanceInfo("t", { activity });
      recordTerminalInput("t", "previous input");
      recordTerminalInput("t", text);
      expect(selectTerminalLastInput(current())).toBeUndefined();
      expect(current().lastInputClearedAt).toBeGreaterThan(0);
      expect(current().activity).toEqual(activity);
    }
  },
);

it("records commands containing clear as ordinary text", () => {
  recordTerminalInput("t", "echo clear");
  expect(selectTerminalLastInput(current())).toBe("echo clear");
});

it("rejects a late write completion from before clear or generation replacement", () => {
  const before = captureInputHistoryScope("t");
  clearTerminalInputHistory("t");
  recordTerminalInput("t", "late input", before);
  expect(selectTerminalLastInput(current())).toBeUndefined();
  const cleared = captureInputHistoryScope("t");
  useTerminalStore.getState().updateInstanceInfo("t", { generation: 2 });
  recordTerminalInput("t", "old generation", cleared);
  expect(selectTerminalLastInput(current())).toBeUndefined();
});

it("does not overwrite a completed shell command with a delayed partial key capture", () => {
  const before = captureInputHistoryScope("t");
  useTerminalStore.getState().updateInstanceInfo("t", {
    lastCommand: "Get-ChildItem",
    lastCommandAt: Date.now(),
  });
  recordTerminalInput("t", "Get-Ch", before);
  expect(selectTerminalLastInput(current())).toBe("Get-ChildItem");
});

it("keeps an input submitted while a clear write was pending", () => {
  const before = captureInputHistoryScope("t");
  recordTerminalInput("t", "new input");
  clearTerminalInputHistory("t", before);
  expect(selectTerminalLastInput(current())).toBe("new input");
});

it("keeps a shell command observed while a clear write was pending", () => {
  const before = captureInputHistoryScope("t");
  useTerminalStore
    .getState()
    .updateInstanceInfo("t", { lastCommand: "new shell command", lastCommandAt: 20 });
  clearTerminalInputHistory("t", before);
  expect(selectTerminalLastInput(current())).toBe("new shell command");
});

it("accepts confirmed agent input after an empty key capture submission", () => {
  const submittedAt = Date.now();
  useTerminalStore.getState().updateInstanceInfo("t", { lastInputSubmissionAt: submittedAt });
  correctTerminalInputFromAgent("t", {
    text: "recalled completed input",
    timestamp: new Date(submittedAt + 10).toISOString(),
  });
  expect(current().lastUserInput).toBe("recalled completed input");
  expect(current().lastUserInputAt).toBe(submittedAt);
});

it("an empty Enter records intent without inventing display text or a task", () => {
  recordTerminalInput("t", "previous");
  const before = current();
  noteTerminalInputSubmission("t");
  expect(current().lastInputSubmissionAt).toBeGreaterThanOrEqual(before.lastUserInputAt!);
  expect(current().lastUserInput).toBe("previous");
  expect(current().lastUserInputAt).toBe(before.lastUserInputAt);
  expect(current().task).toBe(before.task);
});

it("allows a pane clear's own submitted command while preserving unrelated new commands", () => {
  const before = captureInputHistoryScope("t");
  useTerminalStore
    .getState()
    .updateInstanceInfo("t", { lastCommand: "custom clear", lastCommandAt: 20 });
  clearTerminalInputHistory("t", before, { discardDraft: true, submittedCommand: "custom clear" });
  expect(selectTerminalLastInput(current())).toBeUndefined();
  expect(current().inputDraftResetRevision).toBe(1);
});

it("accepts the next input even when it arrives in the clear clock tick", () => {
  clearTerminalInputHistory("t");
  recordTerminalInput("t", "next input");
  expect(selectTerminalLastInput(current())).toBe("next input");
});

it("corrects Tab completion from a current agent submission without changing its submission clock", () => {
  recordTerminalInput("t", "read @par");
  const timestamp = current().lastUserInputAt!;
  correctTerminalInputFromAgent("t", {
    text: "read @partial/path.ts",
    timestamp: new Date(timestamp + 10).toISOString(),
  });
  expect(current().lastUserInput).toBe("read @partial/path.ts");
  expect(current().lastUserInputAt).toBe(timestamp);
});

it("rejects old agent messages after clear and after a newer user submission", () => {
  recordTerminalInput("t", "new input");
  const timestamp = current().lastUserInputAt!;
  correctTerminalInputFromAgent("t", {
    text: "old",
    timestamp: new Date(timestamp - 1).toISOString(),
  });
  expect(current().lastUserInput).toBe("new input");
  clearTerminalInputHistory("t");
  correctTerminalInputFromAgent("t", { text: "old", timestamp: String(timestamp + 10) });
  expect(current().lastUserInput).toBeUndefined();
});

it("화면 보정은 제출 시각을 보존하고 새 입력과 clear를 덮지 않는다", () => {
  recordTerminalInput("t", "/mo");
  const scope = captureInputHistoryScope("t")!;
  expect(correctTerminalInputFromScreen("t", "/model", scope)).toBe(true);
  expect(current().lastUserInput).toBe("/model");
  expect(current().lastUserInputAt).toBe(scope.lastUserInputAt);
  expect(current().lastInputSubmissionAt).toBe(scope.lastInputSubmissionAt);
  recordTerminalInput("t", "next input");
  expect(correctTerminalInputFromScreen("t", "/model", scope)).toBe(false);
  expect(current().lastUserInput).toBe("next input");
  const newer = captureInputHistoryScope("t")!;
  clearTerminalInputHistory("t");
  expect(correctTerminalInputFromScreen("t", "/model", newer)).toBe(false);
  expect(selectTerminalLastInput(current())).toBeUndefined();
});

it("같은 제출의 화면에서 확인한 clear는 부분 입력 표시를 지운다", () => {
  recordTerminalInput("t", "/cl");
  const scope = captureInputHistoryScope("t")!;
  expect(correctTerminalInputFromScreen("t", "/clear", scope)).toBe(true);
  expect(selectTerminalLastInput(current())).toBeUndefined();
  expect(current().inputDraftResetRevision).toBe(1);
});
