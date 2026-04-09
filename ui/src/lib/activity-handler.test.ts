import { describe, it, expect } from "vitest";
import { getHandler } from "./activity-handler";
import { ShellActivityHandler } from "./shell-activity-handler";
import { ClaudeActivityHandler } from "./claude-activity-handler";
import { CodexActivityHandler } from "./codex-activity-handler";

describe("getHandler", () => {
  it("returns ShellActivityHandler for undefined activity", () => {
    expect(getHandler(undefined)).toBeInstanceOf(ShellActivityHandler);
  });

  it("returns ShellActivityHandler for shell activity", () => {
    expect(getHandler({ type: "shell" })).toBeInstanceOf(ShellActivityHandler);
  });

  it("returns ShellActivityHandler for running activity without name", () => {
    expect(getHandler({ type: "running" })).toBeInstanceOf(ShellActivityHandler);
  });

  it("returns ClaudeActivityHandler for Claude interactiveApp", () => {
    expect(getHandler({ type: "interactiveApp", name: "Claude" })).toBeInstanceOf(
      ClaudeActivityHandler,
    );
  });

  it("returns ShellActivityHandler for unknown app name", () => {
    expect(getHandler({ type: "interactiveApp", name: "vim" })).toBeInstanceOf(
      ShellActivityHandler,
    );
  });

  it("returns CodexActivityHandler for Codex interactiveApp", () => {
    expect(getHandler({ type: "interactiveApp", name: "Codex" })).toBeInstanceOf(
      CodexActivityHandler,
    );
  });
});
