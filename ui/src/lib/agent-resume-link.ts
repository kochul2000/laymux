import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { resolveAgentCommand } from "./agent-command";
import { readLineCells, reconstructLine } from "./terminal-cell-map";

export interface AgentResumeHint {
  provider: "claude" | "codex" | "grok";
  sessionId: string;
}

type AgentCommands = Partial<Record<AgentResumeHint["provider"], { command?: string }>>;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`);
const HINT_PATTERN = new RegExp(`^ *(?:(codex) resume|(claude|grok) --resume) (${UUID}) *$`);
const MAX_HINT_ROWS = 16;

/** 출력에서 provider와 UUID 후보만 추출한다. */
export function parseAgentResumeHint(text: string): AgentResumeHint | null {
  const match = HINT_PATTERN.exec(text);
  if (!match || match[0] !== text) return null;
  return { provider: (match[1] ?? match[2]) as AgentResumeHint["provider"], sessionId: match[3] };
}

/** ADR-0125: 옵션은 출력이 아니라 클릭 순간의 설정에서 도출한다. */
export function buildAgentResumeCommand(
  hint: AgentResumeHint,
  settings: AgentCommands,
): string | null {
  if (
    UUID_PATTERN.exec(hint.sessionId)?.[0] !== hint.sessionId ||
    !["claude", "codex", "grok"].includes(hint.provider)
  )
    return null;
  const command = resolveAgentCommand(settings[hint.provider]?.command, hint.provider);
  return `${command} ${hint.provider === "codex" ? "resume" : "--resume"} ${hint.sessionId}`;
}

/** 현재 셀과 좌표를 함께 읽는다. 실제 개행을 자동 wrap으로 재해석하지 않는다. */
function readHint(terminal: Terminal, bufferLine: number) {
  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal") return null;
  let start = bufferLine - 1;
  if (!buffer.getLine(start)) return null;
  while (buffer.getLine(start)?.isWrapped) {
    start--;
    if (start < 0 || bufferLine - 1 - start >= MAX_HINT_ROWS) return null;
  }
  let text = "";
  const points: Array<{ x: number; y: number }> = [];
  for (let row = start; row < start + MAX_HINT_ROWS; row++) {
    const line = buffer.getLine(row);
    if (!line) return null;
    const cells = readLineCells(line);
    while (cells.length && cells.at(-1)!.chars === "" && cells.at(-1)!.width !== 0) cells.pop();
    const mapped = reconstructLine(cells);
    text += mapped.text;
    for (const col of mapped.columns) points.push({ x: col, y: row + 1 });
    if (text.length > 512) return null;
    if (buffer.getLine(row + 1)?.isWrapped) continue;
    const hint = parseAgentResumeHint(text);
    if (!hint) return null;
    const first = text.length - text.trimStart().length;
    const last = text.trimEnd().length - 1;
    const range = { start: points[first], end: points[last] };
    if (!range.start || !range.end) return null;
    return { hint, range, text: text.trim() };
  }
  return null;
}

export function createAgentResumeLinkProvider(
  terminal: Terminal,
  onResume: (hint: AgentResumeHint, isCurrent: () => boolean) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLine, callback) {
      const found = readHint(terminal, bufferLine);
      if (!found) {
        callback(undefined);
        return;
      }
      const buffer = terminal.buffer.active;
      const cols = terminal.cols;
      const isCurrent = () => {
        if (terminal.buffer.active !== buffer || terminal.cols !== cols) return false;
        const current = readHint(terminal, bufferLine);
        if (
          !current ||
          current.text !== found.text ||
          current.range.start.x !== found.range.start.x ||
          current.range.start.y !== found.range.start.y ||
          current.range.end.x !== found.range.end.x ||
          current.range.end.y !== found.range.end.y
        )
          return false;
        return true;
      };
      const link: ILink = {
        text: found.text,
        range: found.range,
        activate: () => {
          if (isCurrent()) onResume(found.hint, isCurrent);
        },
      };
      callback([link]);
    },
  };
}
