import { describe, it, expect } from "vitest";
import type { TerminalInstance } from "@/stores/terminal-store";
import { CLAUDE_INPUT_PENDING_MARKER, CODEX_INPUT_PENDING_MARKER } from "./activity-markers";
import { computeCommandStatus } from "./workspace-summary";
import { hasWorkingTerminal, isTerminalWorking } from "./terminal-working";

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

describe("isTerminalWorking", () => {
  it("is false for an idle terminal", () => {
    expect(isTerminalWorking(terminal())).toBe(false);
  });

  it("is true while a command runs", () => {
    expect(isTerminalWorking(terminal({ activity: { type: "running" } }))).toBe(true);
  });

  it("is true while output is still flowing", () => {
    expect(isTerminalWorking(terminal({ outputActive: true }))).toBe(true);
  });

  it("is false for a finished command", () => {
    expect(isTerminalWorking(terminal({ activity: { type: "shell" }, lastExitCode: 0 }))).toBe(
      false,
    );
  });

  it("is true for Claude's local-agent path, where outputActive stays false (#225)", () => {
    // The regression the whole helper exists for: the pane shows the hourglass
    // from the spinner title alone, and a raw-field check would call it idle.
    expect(
      isTerminalWorking(
        terminal({
          activity: { type: "interactiveApp", name: "Claude" },
          // ✳ is Claude's idle prefix — waiting for the user, not working.
          title: "✳ Refactoring the parser",
          outputActive: false,
          lastExitCode: 0,
        }),
      ),
    ).toBe(false);

    expect(
      isTerminalWorking(
        terminal({
          activity: { type: "interactiveApp", name: "Claude" },
          title: "⠂ Refactoring the parser",
          outputActive: false,
          lastExitCode: 0,
        }),
      ),
    ).toBe(true);
  });

  it("is true for a Codex Braille spinner with no output", () => {
    expect(
      isTerminalWorking(
        terminal({
          activity: { type: "interactiveApp", name: "Codex" },
          title: "⠂ Working",
          outputActive: false,
        }),
      ),
    ).toBe(true);
  });

  it("is false while an agent waits on the user, however busy it looks", () => {
    // A permission prompt is the user's turn — the machine may sleep.
    expect(
      isTerminalWorking(
        terminal({
          activity: { type: "interactiveApp", name: "Claude" },
          title: "⠂ Editing main.rs",
          activityMessage: CLAUDE_INPUT_PENDING_MARKER,
          outputActive: false,
        }),
      ),
    ).toBe(false);

    expect(
      isTerminalWorking(
        terminal({
          activity: { type: "interactiveApp", name: "Codex" },
          title: "⠂ Working",
          activityMessage: CODEX_INPUT_PENDING_MARKER,
          outputActive: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("isTerminalWorking agrees with the pane hourglass", () => {
  // The invariant the helper's doc comment promises. Each row states the icon
  // it expects outright, so the table is a fact about behavior rather than a
  // restatement of the implementation, and then asserts that busy tracks it. If
  // a handler grows a new working state, this is what fails instead of the
  // machine quietly sleeping through it.
  const cases: Array<[string, Partial<TerminalInstance>, string]> = [
    ["idle shell", {}, "—"],
    ["finished ok", { activity: { type: "shell" }, lastExitCode: 0 }, "✓"],
    ["finished with error", { activity: { type: "shell" }, lastExitCode: 1 }, "✗"],
    ["running command", { activity: { type: "running" } }, "⏳"],
    ["output flowing", { outputActive: true }, "⏳"],
    [
      "claude idle title",
      { activity: { type: "interactiveApp", name: "Claude" }, title: "✳ Ready" },
      "✓",
    ],
    [
      "claude working title",
      {
        activity: { type: "interactiveApp", name: "Claude" },
        title: "⠂ Working",
        lastExitCode: 0,
      },
      "⏳",
    ],
    [
      "claude input pending",
      {
        activity: { type: "interactiveApp", name: "Claude" },
        title: "⠂ Working",
        activityMessage: CLAUDE_INPUT_PENDING_MARKER,
      },
      "✓",
    ],
    [
      "codex spinner",
      { activity: { type: "interactiveApp", name: "Codex" }, title: "⠂ Working" },
      "⏳",
    ],
    [
      "codex input pending",
      {
        activity: { type: "interactiveApp", name: "Codex" },
        title: "⠂ Working",
        activityMessage: CODEX_INPUT_PENDING_MARKER,
      },
      "✓",
    ],
    [
      "codex spinner with output",
      {
        activity: { type: "interactiveApp", name: "Codex" },
        title: "⠂ Working",
        outputActive: true,
      },
      "⏳",
    ],
  ];

  it.each(cases)("%s", (_name, overrides, expectedIcon) => {
    const instance = terminal(overrides);
    const status = computeCommandStatus(
      instance.lastExitCode,
      instance.outputActive,
      instance.activityMessage,
      instance.activity,
      instance.title,
    );
    expect(status.icon).toBe(expectedIcon);
    expect(isTerminalWorking(instance)).toBe(expectedIcon === "⏳");
  });
});

describe("hasWorkingTerminal", () => {
  it("is false for an empty list", () => {
    expect(hasWorkingTerminal([])).toBe(false);
  });

  it("is true when any terminal is busy", () => {
    expect(hasWorkingTerminal([terminal(), terminal({ id: "t2", outputActive: true })])).toBe(true);
  });
});
