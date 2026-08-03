import { describe, it, expect } from "vitest";

import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_CODEX_COMMAND,
  isSafeAgentCommand,
  resolveAgentCommand,
} from "./agent-command";

describe("agent command normalization", () => {
  it("accepts executable names, paths, and flags", () => {
    expect(isSafeAgentCommand("claude")).toBe(true);
    expect(isSafeAgentCommand("claude --dangerously-skip-permissions")).toBe(true);
    expect(isSafeAgentCommand("codex --yolo")).toBe(true);
    expect(isSafeAgentCommand("codex --sandbox=danger-full-access")).toBe(true);
    expect(isSafeAgentCommand("/usr/local/bin/claude")).toBe(true);
    expect(isSafeAgentCommand("C:\\tools\\claude.exe --yolo")).toBe(true);
  });

  it("rejects shell metacharacters, newlines, and leading flags", () => {
    for (const unsafe of [
      "",
      "   ",
      "claude; rm -rf /",
      "claude && echo pwned",
      "claude | tee /tmp/x",
      "claude $(whoami)",
      "claude `whoami`",
      "claude > /tmp/out",
      "claude 'quoted'",
      "claude\nrm -rf /",
      "--dangerously-skip-permissions",
    ]) {
      expect(isSafeAgentCommand(unsafe), unsafe).toBe(false);
    }
  });

  it("collapses whitespace and falls back when unusable", () => {
    expect(resolveAgentCommand("  claude   --yolo ", DEFAULT_CLAUDE_COMMAND)).toBe("claude --yolo");
    expect(resolveAgentCommand("", DEFAULT_CLAUDE_COMMAND)).toBe("claude");
    expect(resolveAgentCommand(undefined, DEFAULT_CLAUDE_COMMAND)).toBe("claude");
    expect(resolveAgentCommand("codex; rm -rf /", DEFAULT_CODEX_COMMAND)).toBe("codex");
  });

  it("always resolves to a safe command", () => {
    for (const raw of ["", "claude $(x)", "  ", "-flag", "codex --yolo"]) {
      expect(isSafeAgentCommand(resolveAgentCommand(raw, DEFAULT_CODEX_COMMAND))).toBe(true);
    }
  });
});
