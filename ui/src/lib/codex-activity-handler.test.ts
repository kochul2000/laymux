import { describe, expect, it } from "vitest";
import type { RawTerminalState } from "./activity-handler";
import { CODEX_INPUT_PENDING_MARKER } from "./activity-detection";
import { CodexActivityHandler } from "./codex-activity-handler";

function raw(overrides: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    activityMessage: undefined,
    activity: { type: "interactiveApp", name: "Codex" },
    title: undefined,
    ...overrides,
  };
}

describe("CodexActivityHandler", () => {
  const handler = new CodexActivityHandler();

  it("keeps clear guarded while a quiet Codex turn is unidentified", () => {
    expect(handler.isBusy(raw({ codexTurn: { generation: 1, state: "unknown" } }))).toBe(true);
  });

  it("does not let an old input prompt hide a terminal failure", () => {
    expect(
      handler.computeStatus(
        raw({
          activityMessage: CODEX_INPUT_PENDING_MARKER,
          codexTurn: { generation: 1, state: "failed" },
        }),
      ).icon,
    ).toBe("✗");
  });

  it.each([
    ["completed", true, "⠋ stale title", "✓"],
    ["running", false, "custom title", "⏳"],
    ["failed", true, "", "✗"],
    ["interrupted", true, "", "—"],
    ["unknown", false, "", "—"],
  ] as const)(
    "uses the observed %s turn independently of redraws",
    (state, outputActive, title, icon) => {
      expect(
        handler.computeStatus(
          raw({
            exitCode: 0,
            outputActive,
            title,
            codexTurn: {
              generation: 1,
              sessionId: "session",
              selectionKey: "1",
              turnId: "turn",
              state,
            },
          }),
        ).icon,
      ).toBe(icon);
    },
  );

  it("preserves activity when title stops matching explicit Codex name", () => {
    expect(handler.shouldPreserveActivityOnTitleReset(raw({ title: "⠋laymux" }))).toBe(true);
  });

  it("returns to shell on exitCode", () => {
    expect(handler.shouldPreserveActivityOnExitCode(raw({ exitCode: 0 }))).toBe(false);
  });

  it("treats braille title spinner as active", () => {
    expect(handler.isActiveTitle("⠋laymux")).toBe(true);
    expect(handler.isActiveTitle("laymux")).toBe(false);
  });

  it("uses running status for braille spinner title without outputActive event", () => {
    expect(handler.computeStatus(raw({ title: "⠋laymux" }))).toEqual({
      icon: "⏳",
      color: "var(--yellow)",
    });
  });

  it("treats input pending as success even while output is active", () => {
    expect(
      handler.computeStatus(
        raw({
          outputActive: true,
          activityMessage: CODEX_INPUT_PENDING_MARKER,
          title: "⠋laymux",
        }),
      ),
    ).toEqual({
      icon: "✓",
      color: "var(--green)",
    });
  });

  it("returns spinner title text by default", () => {
    expect(handler.computeStatusMessage(raw({ title: "⠋laymux" }))).toBe("laymux");
  });

  it("keeps title mode strict when no spinner title is present", () => {
    expect(
      handler.computeStatusMessage(
        raw({
          activityMessage: "gpt-5.4 medium · 93% left · C:\\Users",
          statusMessageMode: "title",
        }),
      ),
    ).toBeUndefined();
  });

  it("supports configurable title-bullet formatting", () => {
    expect(
      handler.computeStatusMessage(
        raw({
          title: "⠋laymux",
          activityMessage: "Planning",
          statusMessageMode: "title-bullet",
          statusMessageDelimiter: " | ",
        }),
      ),
    ).toBe("laymux | Planning");
  });

  it("deduplicates identical bullet and title messages", () => {
    expect(
      handler.computeStatusMessage(
        raw({
          title: "⠋laymux",
          activityMessage: "laymux",
          statusMessageMode: "bullet-title",
        }),
      ),
    ).toBe("laymux");
  });
});
