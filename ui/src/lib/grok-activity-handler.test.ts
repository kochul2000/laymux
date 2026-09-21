import {
  GrokActivityHandler,
  extractGrokTitleMessage,
  isGrokTitle,
  isGrokWorkingTitle,
} from "./grok-activity-handler";
import type { RawTerminalState } from "./activity-handler";

function raw(partial: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    activityMessage: undefined,
    activity: { type: "interactiveApp", name: "Grok" },
    title: undefined,
    ...partial,
  };
}

describe("GrokActivityHandler", () => {
  const handler = new GrokActivityHandler();

  it("recognizes session and banner titles but not welcome grok", () => {
    expect(isGrokTitle("Add Grok Support - grok")).toBe(true);
    expect(isGrokTitle("Grok Build")).toBe(true);
    expect(isGrokTitle("grok")).toBe(false);
    expect(isGrokTitle("laymux")).toBe(false);
  });

  it("treats braille or - Running: as working", () => {
    expect(isGrokWorkingTitle("\u{280B} - Running: laymux__list_terminals - title - grok")).toBe(
      true,
    );
    expect(isGrokWorkingTitle("- Running: tool - title - grok")).toBe(true);
    expect(isGrokWorkingTitle("\u{280B} working")).toBe(true);
    expect(isGrokWorkingTitle("title - grok")).toBe(false);
  });

  it("keeps tool and session title after stripping", () => {
    expect(
      extractGrokTitleMessage(
        "\u{280B} - Running: laymux__list_terminals - Add Grok Support - grok",
      ),
    ).toBe("laymux__list_terminals - Add Grok Support");
    expect(extractGrokTitleMessage("Add Grok Support - grok")).toBe("Add Grok Support");
    expect(extractGrokTitleMessage("grok")).toBeUndefined();
  });

  it("uses stripped title as status message", () => {
    expect(
      handler.computeStatusMessage(
        raw({ title: "Add Grok Support - grok", statusMessageMode: "title" }),
      ),
    ).toBe("Add Grok Support");
  });
});
