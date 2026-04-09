import { describe, expect, it } from "vitest";
import { ClaudeActivityHandler } from "./claude-activity-handler";
import type { RawTerminalState } from "./activity-handler";

const SEP = " \u00b7 ";

function raw(overrides: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    activityMessage: undefined,
    activity: { type: "interactiveApp", name: "Claude" },
    title: undefined,
    ...overrides,
  };
}

describe("ClaudeActivityHandler", () => {
  const handler = new ClaudeActivityHandler();

  it("preserves activity on exitCode for Claude sub-commands", () => {
    expect(handler.shouldPreserveActivityOnExitCode(raw({ exitCode: 0 }))).toBe(true);
  });

  describe("computeStatus", () => {
    it("returns pending while output is active", () => {
      expect(handler.computeStatus(raw({ outputActive: true }))).toEqual({
        icon: "⏳",
        color: "var(--yellow)",
      });
    });

    it("prefers active output over exitCode and idle title", () => {
      expect(
        handler.computeStatus(raw({ outputActive: true, exitCode: 0, title: "✳ Claude Code" })),
      ).toEqual({
        icon: "⏳",
        color: "var(--yellow)",
      });
    });

    it("returns success when exitCode is zero", () => {
      expect(handler.computeStatus(raw({ exitCode: 0 }))).toEqual({
        icon: "✓",
        color: "var(--green)",
      });
    });

    it("returns failure when exitCode is non-zero", () => {
      expect(handler.computeStatus(raw({ exitCode: 1 }))).toEqual({
        icon: "✗",
        color: "var(--red)",
      });
    });

    it("returns Claude idle status for idle title", () => {
      expect(handler.computeStatus(raw({ title: "✳ Claude Code" }))).toEqual({
        icon: "✳",
        color: "var(--claude)",
      });
    });

    it("falls back to shell idle status", () => {
      expect(handler.computeStatus(raw({ title: "bash" }))).toEqual({
        icon: "—",
        color: "var(--text-secondary)",
      });
    });
  });

  describe("computeStatusMessage", () => {
    it("returns activityMessage when only bullet exists", () => {
      expect(
        handler.computeStatusMessage(raw({ activityMessage: "Reading file src/main.rs" })),
      ).toBe("Reading file src/main.rs");
    });

    it("returns title message when only spinner title exists", () => {
      expect(handler.computeStatusMessage(raw({ title: "✢ Working on task" }))).toBe(
        "Working on task",
      );
    });

    it("strips braille spinner titles", () => {
      expect(handler.computeStatusMessage(raw({ title: "⠐ Analyzing code" }))).toBe(
        "Analyzing code",
      );
    });

    it("combines bullet and title with default delimiter", () => {
      expect(
        handler.computeStatusMessage(
          raw({ activityMessage: "Reading file", title: "✢ Working on task" }),
        ),
      ).toBe(`Reading file${SEP}Working on task`);
    });

    it("ignores idle titles in status message output", () => {
      expect(handler.computeStatusMessage(raw({ title: "✳ Claude Code" }))).toBeUndefined();
      expect(
        handler.computeStatusMessage(
          raw({ activityMessage: "Reading file", title: "✳ Claude Code" }),
        ),
      ).toBe("Reading file");
    });

    it("returns undefined when no message source exists", () => {
      expect(handler.computeStatusMessage(raw())).toBeUndefined();
      expect(handler.computeStatusMessage(raw({ activityMessage: "" }))).toBeUndefined();
    });

    it("supports bullet mode", () => {
      expect(
        handler.computeStatusMessage(
          raw({
            activityMessage: "Reading file",
            title: "✢ Working on task",
            statusMessageMode: "bullet",
          }),
        ),
      ).toBe("Reading file");
    });

    it("supports title mode", () => {
      expect(
        handler.computeStatusMessage(
          raw({
            activityMessage: "Reading file",
            title: "✢ Working on task",
            statusMessageMode: "title",
          }),
        ),
      ).toBe("Working on task");
    });

    it("supports bullet-title mode", () => {
      expect(
        handler.computeStatusMessage(
          raw({
            activityMessage: "Reading file",
            title: "✢ Working on task",
            statusMessageMode: "bullet-title",
          }),
        ),
      ).toBe(`Reading file${SEP}Working on task`);
    });

    it("supports title-bullet mode", () => {
      expect(
        handler.computeStatusMessage(
          raw({
            activityMessage: "Reading file",
            title: "✢ Working on task",
            statusMessageMode: "title-bullet",
          }),
        ),
      ).toBe(`Working on task${SEP}Reading file`);
    });

    it("supports custom delimiter", () => {
      expect(
        handler.computeStatusMessage(
          raw({
            activityMessage: "Reading file",
            title: "✢ Working on task",
            statusMessageMode: "title-bullet",
            statusMessageDelimiter: " | ",
          }),
        ),
      ).toBe("Working on task | Reading file");
    });
  });

  describe("computeNotification", () => {
    it("returns null because Rust emits notifications", () => {
      expect(handler.computeNotification(raw())).toBeNull();
      expect(handler.computeNotification(raw({ exitCode: 0, activityMessage: "Done" }))).toBeNull();
    });
  });

  describe("Claude lifecycle scenarios", () => {
    it("shows idle status before a task starts", () => {
      expect(handler.computeStatus(raw({ title: "✳ Claude Code" })).icon).toBe("✳");
    });

    it("shows combined message while actively working", () => {
      const state = raw({
        outputActive: true,
        activityMessage: "Editing files",
        title: "✢ Working on task",
      });
      expect(handler.computeStatus(state).icon).toBe("⏳");
      expect(handler.computeStatusMessage(state)).toBe(`Editing files${SEP}Working on task`);
    });

    it("keeps bullet-only output when title is absent", () => {
      const state = raw({ outputActive: true, activityMessage: "Editing files" });
      expect(handler.computeStatusMessage(state)).toBe("Editing files");
    });

    it("keeps success message after completion", () => {
      const state = raw({ exitCode: 0, activityMessage: "Fixed the bug" });
      expect(handler.computeStatus(state).icon).toBe("✓");
      expect(handler.computeStatusMessage(state)).toBe("Fixed the bug");
    });
  });
});
