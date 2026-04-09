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

  it("falls back to activity message when title mode has no spinner title", () => {
    expect(
      handler.computeStatusMessage(
        raw({
          activityMessage: "gpt-5.4 medium · 93% left · C:\\Users",
          statusMessageMode: "title",
        }),
      ),
    ).toBe("gpt-5.4 medium · 93% left · C:\\Users");
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
