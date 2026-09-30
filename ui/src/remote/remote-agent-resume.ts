import type { Terminal } from "@xterm/xterm";
import { buildAgentResumeCommand, createAgentResumeLinkProvider } from "../lib/agent-resume-link";

interface ResumeContext {
  terminalId: string | null;
  leaseId: string | null;
  outputEpoch: number;
  ready: boolean;
  isShell: boolean;
}
interface ResumeDependencies {
  getContext: () => ResumeContext;
  run: (task: () => Promise<void>) => Promise<void>;
  loadCommands: (context: ResumeContext) => Promise<{
    commands: Parameters<typeof buildAgentResumeCommand>[1];
    isShell: boolean;
  }>;
  submit: (context: ResumeContext, command: string) => Promise<void>;
  onError: (error: unknown) => void;
}

/** 같은 PTY·lease·출력 세대를 비동기 경계에서도 유지한다. */
export function createRemoteAgentResumeLinkProvider(terminal: Terminal, deps: ResumeDependencies) {
  let pending = false;
  return createAgentResumeLinkProvider(terminal, (hint, isCurrent) => {
    const context = deps.getContext();
    if (pending || !context.ready || !context.isShell || !context.terminalId || !context.leaseId)
      return;
    const stillAllowed = () => {
      const current = deps.getContext();
      return (
        current.ready &&
        current.isShell &&
        current.terminalId === context.terminalId &&
        current.leaseId === context.leaseId &&
        current.outputEpoch === context.outputEpoch &&
        isCurrent()
      );
    };
    pending = true;
    void deps
      .run(async () => {
        if (!stillAllowed()) return;
        const host = await deps.loadCommands(context);
        if (!stillAllowed() || !host.isShell || !host.commands) return;
        const command = buildAgentResumeCommand(hint, host.commands);
        if (command) await deps.submit(context, command);
      })
      .catch(deps.onError)
      .finally(() => {
        pending = false;
      });
  });
}
