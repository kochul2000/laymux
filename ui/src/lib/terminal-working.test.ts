import { describe, it, expect } from "vitest";
import type { TerminalInstance } from "@/stores/terminal-store";
import { observeTask } from "./terminal-task";
import { hasWorkingTerminal, isTerminalWorking } from "./terminal-working";
const terminal = (overrides: Partial<TerminalInstance> = {}): TerminalInstance => ({
  id: "t",
  profile: "ps",
  syncGroup: "ws",
  workspaceId: "ws",
  label: "",
  lastActivityAt: 0,
  isFocused: false,
  ...overrides,
});
describe("공통 작업 절전 정책", () => {
  it("실행 중 lifecycle은 조용해도 억제한다", () => {
    const task = observeTask(
      undefined,
      { source: "s", taskId: "t", sequence: 1, state: "running" },
      0,
    );
    expect(isTerminalWorking(terminal({ task }))).toBe(true);
  });
  it("지원 에이전트의 타이틀이나 출력만으로 작업을 만들지 않는다", () => {
    for (const name of ["Claude", "Codex", "Grok"])
      expect(
        isTerminalWorking(
          terminal({
            activity: { type: "interactiveApp", name },
            title: "⠋ Working",
            outputActive: true,
          }),
        ),
      ).toBe(false);
  });
  it("비통합 셸과 미지원 TUI의 출력 예외는 유지한다", () => {
    expect(isTerminalWorking(terminal({ outputActive: true }))).toBe(true);
    expect(
      isTerminalWorking(
        terminal({ activity: { type: "interactiveApp", name: "vim" }, outputActive: true }),
      ),
    ).toBe(true);
    expect(isTerminalWorking(terminal())).toBe(false);
  });
  it("다른 pane의 억제 근거를 보존한다", () => {
    expect(hasWorkingTerminal([])).toBe(false);
    expect(hasWorkingTerminal([terminal(), terminal({ id: "other", outputActive: true })])).toBe(
      true,
    );
  });
});
