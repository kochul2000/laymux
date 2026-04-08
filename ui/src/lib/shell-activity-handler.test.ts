import { describe, it, expect } from "vitest";
import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState } from "./activity-handler";

function raw(overrides: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    claudeMessage: undefined,
    activity: undefined,
    title: undefined,
    ...overrides,
  };
}

describe("ShellActivityHandler", () => {
  const handler = new ShellActivityHandler();

  describe("computeStatus", () => {
    it("returns ⏳ yellow when outputActive (priority 1)", () => {
      const result = handler.computeStatus(raw({ outputActive: true }));
      expect(result).toEqual({ icon: "⏳", color: "var(--yellow)" });
    });

    it("outputActive overrides exitCode=0", () => {
      const result = handler.computeStatus(raw({ outputActive: true, exitCode: 0 }));
      expect(result.icon).toBe("⏳");
    });

    it("outputActive overrides exitCode≠0", () => {
      const result = handler.computeStatus(raw({ outputActive: true, exitCode: 1 }));
      expect(result.icon).toBe("⏳");
    });

    it("returns ✓ green when exitCode=0", () => {
      const result = handler.computeStatus(raw({ exitCode: 0 }));
      expect(result).toEqual({ icon: "✓", color: "var(--green)" });
    });

    it("returns ✗ red when exitCode≠0", () => {
      const result = handler.computeStatus(raw({ exitCode: 1 }));
      expect(result).toEqual({ icon: "✗", color: "var(--red)" });
    });

    it("returns ✗ red for negative exit codes", () => {
      const result = handler.computeStatus(raw({ exitCode: -1 }));
      expect(result.icon).toBe("✗");
    });

    it("returns — gray for idle (no exitCode, no outputActive)", () => {
      const result = handler.computeStatus(raw());
      expect(result).toEqual({ icon: "—", color: "var(--text-secondary)" });
    });
  });

  describe("computeStatusMessage", () => {
    it("always returns undefined (shell uses command text directly)", () => {
      expect(handler.computeStatusMessage(raw())).toBeUndefined();
      expect(handler.computeStatusMessage(raw({ claudeMessage: "Building..." }))).toBeUndefined();
      expect(handler.computeStatusMessage(raw({ lastCommand: "npm test" }))).toBeUndefined();
    });
  });

  describe("computeNotification", () => {
    it("always returns null", () => {
      expect(handler.computeNotification(raw())).toBeNull();
      expect(handler.computeNotification(raw({ exitCode: 1 }))).toBeNull();
    });
  });
});
