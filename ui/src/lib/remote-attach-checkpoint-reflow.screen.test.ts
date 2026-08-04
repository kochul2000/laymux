import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { activateTerminalUnicodeProvider } from "./terminal-unicode-width";
import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint";
import type {
  TerminalOutputAppliedSegment,
  TerminalOutputAttachment,
} from "./terminal-output-attach-coordinator";

/**
 * ADR-0133: what a remote attach costs a frame-repainting TUI.
 *
 * Two claims are pinned here, both about bytes on a real grid:
 *
 * 1. The checkpoint path (ADR-0069) is faithful. A screen serialized from the
 *    desktop mirror at the post-resize geometry and replayed in the browser ends
 *    up cell-for-cell identical to a terminal that was simply resized in place
 *    and fed the same bytes. So attach artifacts are not a replay defect.
 * 2. The PTY width change is what damages the frame. Claude/Ink erases only as
 *    many rows as it counted at the previous width, so the wrapped remainder of
 *    the pre-resize frame stays on screen — with its old selection marker — and
 *    later keypresses repaint only the new copy. That is the "pushed up, and the
 *    number I pressed did nothing" report, and it is why attach must publish one
 *    geometry rather than two or three.
 */

const encoder = new TextEncoder();
const GENERATION = 7;

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function makeTerminal(cols: number, rows: number): Terminal {
  const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 1000 });
  activateTerminalUnicodeProvider(term);
  return term;
}

function visibleLines(term: Terminal): string[] {
  const base = term.buffer.active.baseY;
  return Array.from(
    { length: term.rows },
    (_, row) => term.buffer.active.getLine(base + row)?.translateToString(true) ?? "",
  );
}

/** A Claude-Code-style choice prompt, printed the way Ink prints a frame. */
function choiceFrame(width: number, selected: number): string {
  const options = ["1. Yes", "2. Yes, allow all edits", "3. No, and tell Claude what to do"];
  const inner = width - 4;
  const pad = (text: string) => `│ ${text.padEnd(inner, " ")} │`;
  const lines = [
    `╭${"─".repeat(width - 2)}╮`,
    pad("Do you want to make this edit to terminal-render-checkpoint.ts?"),
    pad(""),
    ...options.map((option, index) => pad(`${index === selected ? "❯" : " "} ${option}`)),
    `╰${"─".repeat(width - 2)}╯`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

const FRAME_LINES = 7;

/** Ink's log-update erase: clear + cursor-up per line it believes it printed. */
function inkErase(lineCount: number): string {
  let out = "";
  for (let index = 0; index < lineCount; index += 1) {
    out += "\x1b[2K";
    if (index < lineCount - 1) out += "\x1b[1A";
  }
  return `${out}\x1b[G`;
}

function attachment(snapshot: Uint8Array, cols: number, rows: number): TerminalOutputAttachment {
  return {
    state: {
      version: 1,
      generation: GENERATION,
      snapshotStartSeq: 0,
      snapshotSeq: snapshot.length,
      sourceStartSeq: 0,
      sourceSeq: snapshot.length,
      snapshotKind: "raw",
      protocolRevision: 0,
      modes: { bracketedPaste: false },
      geometry: { revision: 1, cols, rows },
    },
    snapshot,
  };
}

function geometrySegment(
  seqStart: number,
  geometry: { revision: number; cols: number; rows: number },
): TerminalOutputAppliedSegment {
  return {
    generation: GENERATION,
    seqStart,
    seqEnd: seqStart,
    data: new Uint8Array(),
    geometry,
  };
}

const DESKTOP = { cols: 120, rows: 30 };
const REMOTE = { cols: 52, rows: 24 };

interface Replay {
  afterAttach: string[];
  afterKeypress: string[];
}

/** One terminal, resized in place — the geometry change without the transport. */
async function resizedInPlace(prologue: string): Promise<Replay> {
  const term = makeTerminal(DESKTOP.cols, DESKTOP.rows);
  await write(term, `${prologue}${choiceFrame(DESKTOP.cols, 0)}`);
  term.resize(REMOTE.cols, REMOTE.rows);
  await write(term, `${inkErase(FRAME_LINES)}${choiceFrame(REMOTE.cols, 0)}`);
  const afterAttach = visibleLines(term);
  await write(term, `${inkErase(FRAME_LINES)}${choiceFrame(REMOTE.cols, 1)}`);
  const afterKeypress = visibleLines(term);
  term.dispose();
  return { afterAttach, afterKeypress };
}

/** Desktop mirror → serialize → browser replay, at the same geometry. */
async function throughRenderCheckpoint(prologue: string): Promise<Replay> {
  const preResize = encoder.encode(`${prologue}${choiceFrame(DESKTOP.cols, 0)}`);
  const model = new TerminalRenderCheckpointModel();
  await model.attach(attachment(preResize, DESKTOP.cols, DESKTOP.rows));
  await model.apply(geometrySegment(preResize.length, { revision: 2, ...REMOTE }));
  const checkpoint = await model.capture(
    { generation: GENERATION, seq: preResize.length, geometry: { revision: 2, ...REMOTE } },
    512 * 1024,
  );
  model.dispose();

  const term = makeTerminal(REMOTE.cols, REMOTE.rows);
  await write(term, checkpoint.data);
  await write(term, `${inkErase(FRAME_LINES)}${choiceFrame(REMOTE.cols, 0)}`);
  const afterAttach = visibleLines(term);
  await write(term, `${inkErase(FRAME_LINES)}${choiceFrame(REMOTE.cols, 1)}`);
  const afterKeypress = visibleLines(term);
  term.dispose();
  return { afterAttach, afterKeypress };
}

const SCENARIOS: Array<{ name: string; prologue: string }> = [
  { name: "screen only", prologue: "$ claude\r\n" },
  {
    name: "with scrollback above the frame",
    prologue: `${Array.from({ length: 40 }, (_, index) => `line ${index} of build log`).join("\r\n")}\r\n`,
  },
];

describe("a remote attach into a Claude choice prompt", () => {
  for (const scenario of SCENARIOS) {
    it(`replays the same screen as a terminal resized in place (${scenario.name})`, async () => {
      const direct = await resizedInPlace(scenario.prologue);
      const replayed = await throughRenderCheckpoint(scenario.prologue);

      expect(replayed.afterAttach).toEqual(direct.afterAttach);
      expect(replayed.afterKeypress).toEqual(direct.afterKeypress);
    });
  }

  it("leaves the pre-resize frame stranded above the repaint, keypress and all", async () => {
    const { afterAttach, afterKeypress } = await resizedInPlace("$ claude\r\n");

    // The old frame wrapped at 120 columns into more rows than Ink erased, so
    // its remainder survives above the reprinted frame: two frame tops on a
    // screen that should hold one.
    const frameTops = (lines: string[]) => lines.filter((line) => line.startsWith("╭")).length;
    expect(frameTops(afterAttach)).toBeGreaterThan(1);

    // The keypress moved the selection in the live frame only. The stale copy
    // still shows the old one, which is what makes the input look ignored.
    const marked = (lines: string[]) => lines.filter((line) => line.includes("❯"));
    expect(marked(afterKeypress).some((line) => line.includes("❯ 1. Yes"))).toBe(true);
    expect(marked(afterKeypress).some((line) => line.includes("❯ 2. Yes"))).toBe(true);
  });
});
