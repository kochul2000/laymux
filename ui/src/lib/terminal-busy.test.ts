import { describe, it, expect } from "vitest";
import type { TerminalInstance } from "@/stores/terminal-store";
import { hasBusyTerminal, isTerminalBusy } from "./terminal-busy";

function terminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    profile: "PowerShell",
    syncGroup: "Default",
    workspaceId: "ws-1",
    label: "T1",
    lastActivityAt: 0,
    isFocused: false,
    ...overrides,
  };
}

describe("isTerminalBusy", () => {
  it("is false for an idle terminal", () => {
    expect(isTerminalBusy(terminal())).toBe(false);
  });

  it("is true while a command runs", () => {
    expect(isTerminalBusy(terminal({ activity: { type: "running" } }))).toBe(true);
  });

  it("is true while output is still flowing", () => {
    expect(isTerminalBusy(terminal({ outputActive: true }))).toBe(true);
  });

  it("is false for a non-running activity with no output", () => {
    expect(isTerminalBusy(terminal({ activity: { type: "shell" }, outputActive: false }))).toBe(
      false,
    );
  });
});

describe("hasBusyTerminal", () => {
  it("is false for an empty list", () => {
    expect(hasBusyTerminal([])).toBe(false);
  });

  it("is true when any terminal is busy", () => {
    expect(hasBusyTerminal([terminal(), terminal({ id: "t2", outputActive: true })])).toBe(true);
  });
});
