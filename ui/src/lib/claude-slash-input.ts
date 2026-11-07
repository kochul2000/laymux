import type { Terminal } from "@xterm/xterm";
import { agentClearComposer } from "./agent-clear-composer";
import type { TerminalBufferDump } from "./terminal-serialize-registry";

/** Only the completed command name is observed; arguments stay input-owned. */
export function completeClaudeSlashInput(input: string, terminal: Terminal): string {
  const typed = /^(\/[\w:./-]+)(\s.*)?$/u.exec(input);
  const buffer = terminal.buffer.active;
  const synchronized = (terminal as Terminal & { modes?: { synchronizedOutputMode?: boolean } })
    .modes?.synchronizedOutputMode;
  if (!typed || buffer.type !== "normal" || synchronized) return input;
  const lines = Array.from({ length: terminal.rows }, (_, row) => {
    const index = buffer.baseY + row;
    const line = buffer.getLine(index);
    return {
      index,
      text: line?.translateToString(true) ?? "",
      isWrapped: line?.isWrapped ?? false,
    };
  });
  const screen: TerminalBufferDump = {
    cols: terminal.cols,
    rows: terminal.rows,
    length: buffer.length,
    baseY: buffer.baseY,
    lines,
  };
  let command: string | undefined;
  if (agentClearComposer(screen, "Claude") === "draft") {
    const borders = lines.flatMap((line, i) => (/^─{3,}$/u.test(line.text.trim()) ? [i] : []));
    const top = borders.at(-2);
    const bottom = borders.at(-1);
    if (top !== undefined && bottom === top + 2 && !lines[top + 1].isWrapped) {
      command = /^[>❯][ \u00a0]+(\/[\w:./-]+)(?:\s|$)/u.exec(lines[top + 1].text)?.[1];
    }
  } else {
    // A fast Tab→Enter may render only the submitted echo and model chooser.
    const last = lines
      .filter((line) => line.text.trim())
      .at(-1)
      ?.text.trim();
    const title = lines.findIndex((line) => line.text.trim() === "Select model");
    if (
      last?.includes("Enter to set as default") &&
      last.includes("Esc to cancel") &&
      title >= 2 &&
      /^─{3,}$/u.test(lines[title - 1].text.trim()) &&
      !lines[title - 2].isWrapped &&
      /^[>❯][ \u00a0]+\/model\s*$/u.test(lines[title - 2].text)
    ) {
      command = "/model";
    }
  }
  return command && command.startsWith(typed[1]) && command !== typed[1]
    ? command + (typed[2] ?? "")
    : input;
}
