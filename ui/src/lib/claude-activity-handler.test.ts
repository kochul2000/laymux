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

    it("outputActive overrides idle title", () => {
      const result = handler.computeStatus(raw({ outputActive: true, title: "✳ Claude Code" }));
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

    it("returns ✳ Claude accent when idle with ✳ title", () => {
      const result = handler.computeStatus(raw({ title: "✳ Claude Code" }));
      expect(result).toEqual({ icon: "✳", color: "var(--claude)" });
    });

    it("returns — gray when no title (fallback idle)", () => {
      const result = handler.computeStatus(raw());
      expect(result).toEqual({ icon: "—", color: "var(--text-secondary)" });
    });

    it("returns — gray when title has no Claude marker", () => {
      const result = handler.computeStatus(raw({ title: "bash" }));
      expect(result).toEqual({ icon: "—", color: "var(--text-secondary)" });
    });

    it("exitCode=0 overrides idle title (task just completed)", () => {
      const result = handler.computeStatus(raw({ exitCode: 0, title: "✳ Claude Code" }));
      expect(result).toEqual({ icon: "✓", color: "var(--green)" });
    });
  });

  describe("computeStatusMessage", () => {
    it("returns claudeMessage as status text", () => {
      expect(handler.computeStatusMessage(raw({ claudeMessage: "Reading file src/main.rs" }))).toBe(
        "Reading file src/main.rs",
      );
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
      expect(handler.computeNotification(raw({ exitCode: 0, claudeMessage: "Done" }))).toBeNull();
    });
  });

  describe("Claude lifecycle scenarios", () => {
    it("initial entry: title=Claude Code, no exitCode → ✳ idle", () => {
      const state = raw({ title: "✳ Claude Code" });
      const s = handler.computeStatus(state);
      expect(s).toEqual({ icon: "✳", color: "var(--claude)" });
    });

    it("working state: outputActive=true → ⏳ with claudeMessage", () => {
      const state = raw({ outputActive: true, claudeMessage: "Editing files" });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("⏳");
      expect(m).toBe("Editing files");
    });

    it("thinking with spinner title: outputActive=true → ⏳", () => {
      const state = raw({ outputActive: true, title: "✢ Working on task" });
      const s = handler.computeStatus(state);
      expect(s.icon).toBe("⏳");
    });

    it("thinking with braille spinner: outputActive=true → ⏳", () => {
      const state = raw({ outputActive: true, title: "⠐ Analyzing code" });
      const s = handler.computeStatus(state);
      expect(s.icon).toBe("⏳");
    });

    it("task completed: exitCode=0, claudeMessage → ✓ with message", () => {
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

    it("back to idle after task: ✳ title, no exitCode → ✳", () => {
      // After exitCode is cleared and Claude returns to idle prompt
      const state = raw({ title: "✳ Claude Code" });
      const s = handler.computeStatus(state);
      expect(s).toEqual({ icon: "✳", color: "var(--claude)" });
    });
  });
});
