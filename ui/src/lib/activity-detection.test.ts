import { describe, it, expect } from "vitest";
import {
  detectActivityFromTitle,
  detectActivityFromCommand,
  detectClaudeTaskTransition,
  extractClaudeTaskDesc,
  isGenericClaudeTitle,
  getClaudeCompletionMessage,
  parseClaudeMode,
  isRalphActive,
} from "./activity-detection";

describe("detectActivityFromTitle", () => {
  it("detects vim from title", () => {
    expect(detectActivityFromTitle("vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("detects vim in longer title", () => {
    expect(detectActivityFromTitle("vim - file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects Claude Code as Claude", () => {
    expect(detectActivityFromTitle("Claude Code")).toEqual({
      type: "interactiveApp",
      name: "Claude",
    });
  });

  it("detects nvim as neovim", () => {
    expect(detectActivityFromTitle("nvim")).toEqual({ type: "interactiveApp", name: "neovim" });
  });

  it("returns undefined for unknown title", () => {
    expect(detectActivityFromTitle("bash")).toBeUndefined();
  });

  it("returns undefined for empty title", () => {
    expect(detectActivityFromTitle("")).toBeUndefined();
  });

  it("does not false-positive on app names embedded in words", () => {
    expect(detectActivityFromTitle("Review current directory structure")).toBeUndefined();
    expect(detectActivityFromTitle("✳ Review code changes")).toBeUndefined();
    expect(detectActivityFromTitle("navigation helper")).toBeUndefined();
    expect(detectActivityFromTitle("environment variables")).toBeUndefined();
  });

  it("detects app names with surrounding delimiters", () => {
    expect(detectActivityFromTitle("vim - file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
    expect(detectActivityFromTitle("vi file.txt")).toEqual({ type: "interactiveApp", name: "vim" });
    expect(detectActivityFromTitle("running:vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("returns undefined for path-like titles containing app names", () => {
    expect(
      detectActivityFromTitle("//wsl.localhost/Ubuntu/home/user/python_projects"),
    ).toBeUndefined();
    expect(detectActivityFromTitle("/home/user/vim-config")).toBeUndefined();
    expect(detectActivityFromTitle("C:\\Users\\name\\node_modules")).toBeUndefined();
  });
});

describe("detectActivityFromCommand", () => {
  it("detects vim command", () => {
    expect(detectActivityFromCommand("vim file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects bare vim", () => {
    expect(detectActivityFromCommand("vim")).toEqual({ type: "interactiveApp", name: "vim" });
  });

  it("detects nvim as neovim", () => {
    expect(detectActivityFromCommand("nvim src/main.rs")).toEqual({
      type: "interactiveApp",
      name: "neovim",
    });
  });

  it("detects nano", () => {
    expect(detectActivityFromCommand("nano /etc/hosts")).toEqual({
      type: "interactiveApp",
      name: "nano",
    });
  });

  it("detects htop", () => {
    expect(detectActivityFromCommand("htop")).toEqual({ type: "interactiveApp", name: "htop" });
  });

  it("detects python3", () => {
    expect(detectActivityFromCommand("python3")).toEqual({
      type: "interactiveApp",
      name: "python",
    });
  });

  it("detects python (not python3 script.py style)", () => {
    // 'python' bare is interactive REPL
    expect(detectActivityFromCommand("python")).toEqual({ type: "interactiveApp", name: "python" });
  });

  it("does not detect unknown commands", () => {
    expect(detectActivityFromCommand("ls -la")).toBeUndefined();
    expect(detectActivityFromCommand("npm test")).toBeUndefined();
    expect(detectActivityFromCommand("cargo build")).toBeUndefined();
  });

  it("does not detect __preexec__ marker", () => {
    expect(detectActivityFromCommand("__preexec__")).toBeUndefined();
  });

  it("handles sudo prefix", () => {
    expect(detectActivityFromCommand("sudo vim /etc/hosts")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("handles commands with path prefix", () => {
    expect(detectActivityFromCommand("/usr/bin/vim file.txt")).toEqual({
      type: "interactiveApp",
      name: "vim",
    });
  });

  it("detects claude as Claude", () => {
    expect(detectActivityFromCommand("claude")).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("returns undefined for empty command", () => {
    expect(detectActivityFromCommand("")).toBeUndefined();
  });
});

describe("detectClaudeTaskTransition", () => {
  const claudeActivity = { type: "interactiveApp" as const, name: "Claude" };
  const vimActivity = { type: "interactiveApp" as const, name: "vim" };
  const shellActivity = { type: "shell" as const };

  it("detects completed: spinner → ✳ with Claude activity", () => {
    expect(
      detectClaudeTaskTransition("✶ Working on feature", "✳ Feature done", claudeActivity, false),
    ).toBe("completed");
  });

  it("detects started: ✳ → spinner with Claude activity", () => {
    expect(detectClaudeTaskTransition("✳ Claude Code", "✶ Working on task", claudeActivity, false)).toBe(
      "started",
    );
  });

  it("returns null for same state: spinner → spinner (still working)", () => {
    expect(detectClaudeTaskTransition("✶ Task A", "✻ Task B", claudeActivity, false)).toBeNull();
  });

  it("returns null for same state ✳ → ✳ (still idle)", () => {
    expect(
      detectClaudeTaskTransition("✳ Claude Code", "✳ Something else", claudeActivity, false),
    ).toBeNull();
  });

  it("returns null for non-Claude activity even with matching prefixes", () => {
    expect(detectClaudeTaskTransition("✶ Working", "✳ Done", vimActivity, false)).toBeNull();
    expect(detectClaudeTaskTransition("✶ Working", "✳ Done", shellActivity, false)).toBeNull();
  });

  it("returns null when activity is undefined", () => {
    expect(detectClaudeTaskTransition("✶ Working", "✳ Done", undefined, false)).toBeNull();
  });

  it("does not return started on first title set (previousTitle undefined)", () => {
    expect(detectClaudeTaskTransition(undefined, "✶ Starting task", claudeActivity, false)).toBeNull();
  });

  it("returns null for titles without spinner or ✳ prefix", () => {
    // Both non-idle, non-spinner plain text → both treated as "working" → null
    expect(detectClaudeTaskTransition("Claude Code", "Something", claudeActivity, false)).toBeNull();
  });

  it("detects completed with various spinner characters", () => {
    expect(detectClaudeTaskTransition("✻ Building", "✳ Done", claudeActivity, false)).toBe("completed");
    expect(detectClaudeTaskTransition("✽ Running", "✳ Done", claudeActivity, false)).toBe("completed");
    expect(detectClaudeTaskTransition("✢ Testing", "✳ Done", claudeActivity, false)).toBe("completed");
    expect(detectClaudeTaskTransition("· Thinking", "✳ Done", claudeActivity, false)).toBe("completed");
    expect(detectClaudeTaskTransition("* Working", "✳ Done", claudeActivity, false)).toBe("completed");
  });

  it("detects completed when previousTitle is spinner and new is ✳ Claude Code (idle)", () => {
    expect(detectClaudeTaskTransition("✶ Building project", "✳ Claude Code", claudeActivity, false)).toBe(
      "completed",
    );
  });

  // Garbled encoding tests (Windows CP949 path)
  it("detects completed when Claude exits while working (claudeExited=true)", () => {
    // Claude was working (spinner), then exited entirely (title changed to shell prompt)
    expect(
      detectClaudeTaskTransition("✶ Building project", "bash", claudeActivity, true),
    ).toBe("completed");
  });

  it("returns null when Claude exits while idle (claudeExited=true)", () => {
    // Claude was idle, user exited → no task was in progress, no notification needed
    expect(
      detectClaudeTaskTransition("✳ Claude Code", "bash", claudeActivity, true),
    ).toBeNull();
  });

  it("detects completed when Claude exits with various spinner prefixes", () => {
    expect(detectClaudeTaskTransition("✻ Fix bug", "user@host:~", claudeActivity, true)).toBe("completed");
    expect(detectClaudeTaskTransition("✽ Running", "zsh", claudeActivity, true)).toBe("completed");
    expect(detectClaudeTaskTransition("· Thinking", "PowerShell", claudeActivity, true)).toBe("completed");
  });

  it("detects completed with garbled ✳ encoding", () => {
    const garbledIdle = "\udce2\uc454 Claude Code";
    const garbledWorking = "\udce2\uc7fc Claude Code";
    expect(detectClaudeTaskTransition(garbledWorking, garbledIdle, claudeActivity, false)).toBe(
      "completed",
    );
  });

  it("detects started with garbled encoding", () => {
    const garbledIdle = "\udce2\uc454 Claude Code";
    const garbledWorking = "\udce2\uc7fc Working on task";
    expect(detectClaudeTaskTransition(garbledIdle, garbledWorking, claudeActivity, false)).toBe("started");
  });
});

describe("extractClaudeTaskDesc", () => {
  it("strips ✳ prefix", () => {
    expect(extractClaudeTaskDesc("✳ Build project")).toBe("Build project");
  });

  it("strips garbled ✳ prefix", () => {
    expect(extractClaudeTaskDesc("\udce2\uc454 Build project")).toBe("Build project");
  });

  it("strips spinner prefix", () => {
    expect(extractClaudeTaskDesc("✶ Working")).toBe("Working");
  });

  it("returns empty for prefix-only title", () => {
    expect(extractClaudeTaskDesc("✳")).toBe("");
  });
});

describe("isGenericClaudeTitle", () => {
  it("returns true for Claude Code", () => {
    expect(isGenericClaudeTitle("Claude Code")).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isGenericClaudeTitle("")).toBe(true);
  });

  it("returns false for actual task description", () => {
    expect(isGenericClaudeTitle("Build project")).toBe(false);
    expect(isGenericClaudeTitle("Basic arithmetic")).toBe(false);
  });
});

describe("getClaudeCompletionMessage", () => {
  it("extracts task description from previous (spinner) title when new title is generic idle", () => {
    expect(getClaudeCompletionMessage("✻ Fix the bug", "✳ Claude Code")).toBe("Fix the bug");
  });

  it("works with various spinner characters", () => {
    expect(getClaudeCompletionMessage("✶ Build project", "✳ Claude Code")).toBe("Build project");
    expect(getClaudeCompletionMessage("✽ Running tests", "✳ Claude Code")).toBe("Running tests");
    expect(getClaudeCompletionMessage("· Thinking about solution", "✳ Claude Code")).toBe(
      "Thinking about solution",
    );
  });

  it("prefers previous title description over new title description", () => {
    expect(getClaudeCompletionMessage("✻ Fix the bug", "✳ Review results")).toBe("Fix the bug");
  });

  it("falls back to new title when previous title is generic", () => {
    expect(getClaudeCompletionMessage("✻ Claude Code", "✳ Some specific task")).toBe(
      "Some specific task",
    );
  });

  it("falls back to default message when both titles are generic", () => {
    expect(getClaudeCompletionMessage("✻ Claude Code", "✳ Claude Code")).toBe(
      "Claude task completed",
    );
  });

  it("falls back to default message when both titles extract to empty", () => {
    expect(getClaudeCompletionMessage("✻", "✳")).toBe("Claude task completed");
  });

  it("handles undefined previous title", () => {
    expect(getClaudeCompletionMessage(undefined, "✳ Claude Code")).toBe("Claude task completed");
  });

  it("handles garbled encoding — still creates non-generic message", () => {
    // Garbled spinner prefix may not be fully stripped, but result is still non-generic
    const message = getClaudeCompletionMessage(
      "\udce2\uc7fc Build project",
      "\udce2\uc454 Claude Code",
    );
    expect(isGenericClaudeTitle(message)).toBe(false);
    expect(message).toContain("Build project");
  });

  it("handles lowercase generic 'claude' in previous title", () => {
    expect(getClaudeCompletionMessage("✻ claude", "✳ Claude Code")).toBe("Claude task completed");
  });
});

describe("Claude completion notification wiring (bug repro)", () => {
  it("old code skips notification when title transitions to idle", () => {
    // OLD buggy flow: extracts from newTitle → "Claude Code" → generic → SKIP
    const oldTaskDesc = extractClaudeTaskDesc("✳ Claude Code");
    expect(isGenericClaudeTitle(oldTaskDesc)).toBe(true);
  });

  it("new code extracts task from previous title", () => {
    const message = getClaudeCompletionMessage("✻ Fix the bug", "✳ Claude Code");
    expect(message).toBe("Fix the bug");
    expect(isGenericClaudeTitle(message)).toBe(false);
  });
});

describe("parseClaudeMode", () => {
  const claudeActivity = { type: "interactiveApp" as const, name: "Claude" };

  it("returns undefined for non-Claude terminals", () => {
    expect(parseClaudeMode("some title", { type: "shell" })).toBeUndefined();
    expect(parseClaudeMode("some title", { type: "interactiveApp", name: "vim" })).toBeUndefined();
    expect(parseClaudeMode("some title", undefined)).toBeUndefined();
  });

  it("returns idle for ✳ prefix title", () => {
    expect(parseClaudeMode("✳ Claude Code", claudeActivity)).toBe("idle");
  });

  it("returns working for spinner prefix title", () => {
    expect(parseClaudeMode("✶ Writing code...", claudeActivity)).toBe("working");
  });

  it("returns plan when title contains 'plan'", () => {
    expect(parseClaudeMode("✶ Plan mode", claudeActivity)).toBe("plan");
    expect(parseClaudeMode("✳ Plan: approach for fix", claudeActivity)).toBe("plan");
  });

  it("returns danger when title contains 'danger'", () => {
    expect(parseClaudeMode("✳ Danger mode active", claudeActivity)).toBe("danger");
  });

  it("returns undefined when title is undefined", () => {
    expect(parseClaudeMode(undefined, claudeActivity)).toBeUndefined();
  });
});

describe("isRalphActive", () => {
  it("returns true when title contains 'ralph'", () => {
    expect(isRalphActive("✶ Ralph: fixing bugs")).toBe(true);
    expect(isRalphActive("✳ Ralph loop active")).toBe(true);
  });

  it("returns false for normal Claude titles", () => {
    expect(isRalphActive("✳ Claude Code")).toBe(false);
    expect(isRalphActive(undefined)).toBe(false);
  });
});
