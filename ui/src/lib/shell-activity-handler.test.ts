import { describe, it, expect } from "vitest";
import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState } from "./activity-handler";

function raw(overrides: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    activityMessage: undefined,
    activity: undefined,
    title: undefined,
    ...overrides,
  };
}

describe("ShellActivityHandler", () => {
  const handler = new ShellActivityHandler();

  describe("computeStatusMessage", () => {
    it("always returns undefined (shell uses command text directly)", () => {
      expect(handler.computeStatusMessage(raw())).toBeUndefined();
      expect(handler.computeStatusMessage(raw({ activityMessage: "Building..." }))).toBeUndefined();
      expect(handler.computeStatusMessage(raw({ lastCommand: "npm test" }))).toBeUndefined();
    });
  });
});
