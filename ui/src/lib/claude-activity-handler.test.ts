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
    it("returns claudeMessage when only bullet exists", () => {
      expect(handler.computeStatusMessage(raw({ claudeMessage: "Reading file src/main.rs" }))).toBe(
        "Reading file src/main.rs",
      );
    });

    it("returns title message when only title exists (spinner stripped)", () => {
      expect(handler.computeStatusMessage(raw({ title: "✢ Working on task" }))).toBe(
        "Working on task",
      );
    });

    it("returns title message with braille spinner stripped", () => {
      expect(handler.computeStatusMessage(raw({ title: "⠐ Analyzing code" }))).toBe(
        "Analyzing code",
      );
    });

    it("combines bullet and title with · separator when both exist", () => {
      expect(
        handler.computeStatusMessage(
          raw({ claudeMessage: "Reading file", title: "✢ Working on task" }),
        ),
      ).toBe("Reading file · Working on task");
    });

    it("combines bullet and braille title", () => {
      expect(
        handler.computeStatusMessage(
          raw({ claudeMessage: "Editing files", title: "⠐ Fix the bug" }),
        ),
      ).toBe("Editing files · Fix the bug");
    });

    it("returns undefined when no claudeMessage and no title", () => {
      expect(handler.computeStatusMessage(raw())).toBeUndefined();
    });

    it("returns undefined for empty claudeMessage and no title", () => {
      expect(handler.computeStatusMessage(raw({ claudeMessage: "" }))).toBeUndefined();
    });

    it("skips title when it has no spinner prefix (plain title)", () => {
      expect(handler.computeStatusMessage(raw({ title: "bash" }))).toBeUndefined();
    });

    it("skips idle title (✳ prefix) — not useful as status message", () => {
      expect(handler.computeStatusMessage(raw({ title: "✳ Claude Code" }))).toBeUndefined();
    });

    it("bullet only when title is idle ✳", () => {
      expect(
        handler.computeStatusMessage(
          raw({ claudeMessage: "Reading file", title: "✳ Claude Code" }),
        ),
      ).toBe("Reading file");
    });

    it("skips title when stripped text equals 'Claude Code'", () => {
      expect(handler.computeStatusMessage(raw({ title: "✢ Claude Code" }))).toBeUndefined();
    });

    describe("statusMessageMode", () => {
      const both = { claudeMessage: "Reading file", title: "✢ Working on task" };

      it("bullet mode: only bullet", () => {
        expect(handler.computeStatusMessage(raw({ ...both, statusMessageMode: "bullet" }))).toBe(
          "Reading file",
        );
      });

      it("bullet mode: undefined when no bullet", () => {
        expect(
          handler.computeStatusMessage(
            raw({ title: "✢ Working on task", statusMessageMode: "bullet" }),
          ),
        ).toBeUndefined();
      });

      it("title mode: only title", () => {
        expect(handler.computeStatusMessage(raw({ ...both, statusMessageMode: "title" }))).toBe(
          "Working on task",
        );
      });

      it("title mode: undefined when no spinner title", () => {
        expect(
          handler.computeStatusMessage(
            raw({ claudeMessage: "Reading file", statusMessageMode: "title" }),
          ),
        ).toBeUndefined();
      });

      it("bullet-title mode (default): bullet · title", () => {
        expect(
          handler.computeStatusMessage(raw({ ...both, statusMessageMode: "bullet-title" })),
        ).toBe("Reading file · Working on task");
      });

      it("title-bullet mode: title · bullet", () => {
        expect(
          handler.computeStatusMessage(raw({ ...both, statusMessageMode: "title-bullet" })),
        ).toBe("Working on task · Reading file");
      });

      it("title-bullet mode: falls back to bullet when no title", () => {
        expect(
          handler.computeStatusMessage(
            raw({ claudeMessage: "Reading file", statusMessageMode: "title-bullet" }),
          ),
        ).toBe("Reading file");
      });

      it("custom delimiter", () => {
        expect(
          handler.computeStatusMessage(
            raw({ ...both, statusMessageMode: "bullet-title", statusMessageDelimiter: " | " }),
          ),
        ).toBe("Reading file | Working on task");
      });

      it("custom delimiter with title-bullet", () => {
        expect(
          handler.computeStatusMessage(
            raw({ ...both, statusMessageMode: "title-bullet", statusMessageDelimiter: " — " }),
          ),
        ).toBe("Working on task — Reading file");
      });
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

    it("working state: outputActive=true → ⏳ with combined message", () => {
      const state = raw({
        outputActive: true,
        claudeMessage: "Editing files",
        title: "✢ Working on task",
      });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("⏳");
      expect(m).toBe("Editing files · Working on task");
    });

    it("working state: bullet only when no spinner title", () => {
      const state = raw({ outputActive: true, claudeMessage: "Editing files" });
      const m = handler.computeStatusMessage(state);
      expect(m).toBe("Editing files");
    });

    it("thinking with spinner title only → title message", () => {
      const state = raw({ outputActive: true, title: "✢ Working on task" });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("⏳");
      expect(m).toBe("Working on task");
    });

    it("thinking with braille spinner only → title message", () => {
      const state = raw({ outputActive: true, title: "⠐ Analyzing code" });
      const s = handler.computeStatus(state);
      const m = handler.computeStatusMessage(state);
      expect(s.icon).toBe("⏳");
      expect(m).toBe("Analyzing code");
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
