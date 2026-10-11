import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import {
  buildAgentResumeCommand,
  createAgentResumeLinkProvider,
  findAgentResumeRanges,
} from "../lib/agent-resume-link";

interface ResumeContext {
  terminalId: string | null;
  leaseId: string | null;
  outputEpoch: number;
  ready: boolean;
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
    if (pending || !context.ready || !context.terminalId || !context.leaseId) return;
    const stillAllowed = () => {
      const current = deps.getContext();
      return (
        current.ready &&
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
        // Only the host decides whether a shell owns the prompt: the local
        // navigation snapshot is polled only while the drawer is open, so it
        // can still show the agent that printed this hint.
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

interface Underline {
  marker: IMarker;
  decoration: IDecoration;
  x: number;
  width: number;
}

/**
 * ADR-0316: 터치에는 hover가 없으므로 보이는 복원 안내에 밑줄을 상시 둔다.
 * 출력·스크롤·크기 변경 뒤 화면을 다시 읽고, 같은 셀의 밑줄은 유지한다.
 */
export function installAgentResumeUnderlines(terminal: Terminal, className: string) {
  let underlines: Underline[] = [];
  let frame = 0;
  const refresh = () => {
    frame = 0;
    const buffer = terminal.buffer.active;
    const segments =
      buffer.type === "normal"
        ? findAgentResumeRanges(
            terminal,
            buffer.viewportY + 1,
            buffer.viewportY + terminal.rows,
          ).flatMap(({ start, end }) =>
            Array.from({ length: end.y - start.y + 1 }, (_, index) => {
              const y = start.y + index;
              const x = y === start.y ? start.x : 1;
              const last = y === end.y ? end.x : terminal.cols;
              return { line: y - 1, x: x - 1, width: last - x + 1 };
            }),
          )
        : [];
    const previous = underlines;
    underlines = [];
    for (const segment of segments) {
      const reused = previous.findIndex(
        (underline) =>
          !underline.marker.isDisposed &&
          underline.marker.line === segment.line &&
          underline.x === segment.x &&
          underline.width === segment.width,
      );
      if (reused >= 0) {
        underlines.push(previous.splice(reused, 1)[0]);
        continue;
      }
      const marker = terminal.registerMarker(segment.line - (buffer.baseY + buffer.cursorY));
      if (!marker) continue;
      const decoration = terminal.registerDecoration({
        marker,
        x: segment.x,
        width: segment.width,
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      decoration.onRender((element) => element.classList.add(className));
      underlines.push({ marker, decoration, ...segment });
    }
    for (const underline of previous) underline.marker.dispose();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refresh);
  };
  terminal.onWriteParsed(schedule);
  terminal.onScroll(schedule);
  terminal.onResize(schedule);
  terminal.buffer.onBufferChange(schedule);
}
