import type { AgentId } from "@/stores/agent-startup-store";
import type { AgentInstallationResult } from "./tauri-api";

const DOCS: Record<AgentId, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
  grok: "https://docs.x.ai/build/overview",
};

const COMMANDS = {
  claude: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    unix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    windows:
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    unix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
  grok: {
    windows: "irm https://x.ai/cli/install.ps1 | iex",
    unix: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
} as const;

export function agentInstallGuidance(
  agentId: AgentId,
  environment: AgentInstallationResult["environment"],
  profileCommandLine: string,
): { docs: string; command: string | null } {
  if (environment === "unknown") return { docs: DOCS[agentId], command: null };
  if (environment === "wsl" || environment === "linux") {
    return { docs: DOCS[agentId], command: COMMANDS[agentId].unix };
  }
  const command = COMMANDS[agentId].windows;
  const isPowerShell = /(?:^|[\\/\s])(?:pwsh|powershell)(?:\.exe)?(?:\s|$)/i.test(
    profileCommandLine,
  );
  if (isPowerShell || agentId === "codex") return { docs: DOCS[agentId], command };
  // A profile may use cmd.exe or an unfamiliar Windows shell. Make the shell
  // explicit so PowerShell syntax is never pasted as a bare cmd command.
  return { docs: DOCS[agentId], command: `powershell -NoProfile -Command "${command}"` };
}
