import { describe, expect, it } from "vitest";
import { agentInstallGuidance } from "./agent-install-guidance";

describe("agentInstallGuidance", () => {
  it("uses the checked environment rather than the host OS", () => {
    expect(agentInstallGuidance("codex", "wsl", "wsl.exe").command).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
  });

  it("names PowerShell explicitly for an unfamiliar Windows shell", () => {
    expect(agentInstallGuidance("claude", "windows", "cmd.exe").command).toBe(
      'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"',
    );
  });

  it("does not guess an install command for an unknown environment", () => {
    expect(agentInstallGuidance("grok", "unknown", "ssh custom")).toEqual({
      docs: "https://docs.x.ai/build/overview",
      command: null,
    });
  });
});
