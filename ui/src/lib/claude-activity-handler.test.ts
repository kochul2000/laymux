import { describe, it, expect } from "vitest";
import { ClaudeActivityHandler } from "./claude-activity-handler";
import type { RawTerminalState } from "./activity-handler";

function raw(overrides: Partial<RawTerminalState> = {}): RawTerminalState {
  return {
    exitCode: undefined,
    outputActive: false,
    lastCommand: undefined,
    claudeMessage: undefined,
    activity: { type: "interactiveApp", name: "Claude" },
    title: undefined,
    ...overrides,
  };
}

describe("ClaudeActivityHandler", () => {
  const handler = new ClaudeActivityHandler();

  describe("computeStatus", () => {
    it("returns ⏳ yellow when outputActive (working/responding)", () => {
      const result = handler.computeStatus(raw({ outputActive: true }));
      expect(result).toEqual({ icon: "⏳", color: "var(--yellow)" });
    });

    it("outputActive overrides exitCode", () => {
      const result = handler.computeStatus(raw({ outputActive: true, exitCode: 0 }));
      expect(result.icon).toBe("⏳");
    });

    it("returns ✓ green when task completed (synthetic exitCode=0)", () => {
      const result = handler.computeStatus(raw({ exitCode: 0 }));
      expect(result).toEqual({ icon: "✓", color: "var(--green)" });
    });

    it("returns ✗ red when exitCode≠0", () => {
      const result = handler.computeStatus(raw({ exitCode: 1 }));
      expect(result).toEqual({ icon: "✗", color: "var(--red)" });
    });

    it("returns — gray when idle (no exitCode, no outputActive)", () => {
      const result = handler.computeStatus(raw());
      expect(result).toEqual({ icon: "—", color: "var(--text-secondary)" });
    });
  });

  describe("computeStatusMessage", () => {
    it("returns claudeMessage as status text", () => {
      expect(
        handler.computeStatusMessage(raw({ claudeMessage: "Reading file src/main.rs" })),
      ).toBe("Reading file src/main.rs");
    });

    it("returns undefined when no claudeMessage", () => {
      expect(handler.computeStatusMessage(raw())).toBeUndefined();
    });

    it("returns undefined for empty claudeMessage", () => {
      expect(handler.computeStatusMessage(raw({ claudeMessage: "" }))).toBeUndefined();
    });
  });

  describe("computeNotification", () => {
    it("returns null (Rust handles notifications)", () => {
      expect(handler.computeNotification(raw())).toBeNull();
      expect(
        handler.computeNotification(raw({ exitCode: 0, claudeMessage: "Done" })),
      ).toBeNull();
    });
  });

  describe("Claude lifecycle scenarios", () => {
    it("working state: outputActive=true → ⏳", () => {
      const s = handler.computeStatus(raw({ outputActive: true }));
      const m = handler.computeStatusMessage(
        raw({ outputActive: true, claudeMessage: "Editing files" }),
      );
      expect(s.icon).toBe("⏳");
      expect(m).toBe("Editing files");
    });

    it("task completed: outputActive=false, exitCode=0, claudeMessage → ✓ with message", () => {
      const state = raw({ exitCode: 0, claudeMessage: "Fixed the bug" });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("✓");
      expect(m).toBe("Fixed the bug");
    });

    it("idle after completion: exitCode=0, no message → ✓", () => {
      const state = raw({ exitCode: 0 });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("✓");
      expect(m).toBeUndefined();
    });
  });
});
