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

  // ── Regression guard for issue #234 ──
  // When Claude Code is running, its title can flip to:
  //   - a path-like string (e.g. "~/project" or PowerShell's prompt rewrite)
  //   - a Braille-only spinner title whose buffer hasn't yet logged
  //     "Claude Code" in a form `any_terminal_title_contains` can match
  // In those cases Rust's `detect_interactive_app_from_live_title` returns
  // `None`, so the `terminal-title-changed` event carries
  // `interactiveApp: null`. Without `shouldPreserveActivityOnTitleReset`,
  // useSyncEvents would overwrite the current `interactiveApp: Claude`
  // activity with `shell`, causing the workspace icon in the top-left to
  // flip back to "shell" even though Claude Code is still alive in the
  // terminal. Codex already preserves on title reset — this test locks in
  // the same behaviour for Claude.
  it("preserves activity on title reset (issue #234)", () => {
    expect(handler.shouldPreserveActivityOnTitleReset?.(raw({ title: "~/project" }))).toBe(true);
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

  describe("Claude lifecycle scenarios", () => {
    it("keeps bullet-only output when title is absent", () => {
      const state = raw({ outputActive: true, activityMessage: "Editing files" });
      expect(handler.computeStatusMessage(state)).toBe("Editing files");
    });
  });
});
