import { getTerminalInspector, type TerminalBufferDump } from "./terminal-serialize-registry";

type Provider = "Claude" | "Codex";
const DELETE_BATCH = "\x7f\x1b[3~".repeat(128);
const POLL_MS = 60;
const MAX_ROUNDS = 32;
const pending = new Set<string>();

/** Only the current viewport may authorize a destructive slash command. */
export function agentClearComposer(
  screen: TerminalBufferDump,
  provider: Provider,
): "empty" | "draft" | "unsupported" {
  if (screen.cols < 40) return "unsupported";
  const lines = screen.lines.filter((l) => l.index >= screen.baseY).map((l) => l.text.trimEnd());
  if (
    lines.some((l) =>
      /esc to interrupt|Reconnecting|Task is still running|\[Image\s|Vim:|-- (?:NORMAL|INSERT|REPLACE) --|enter.*(?:confirm|select)|esc.*(?:cancel|back)/i.test(
        l,
      ),
    )
  )
    return "unsupported";
  if (provider === "Codex") {
    const prompt = lines.reduce(
      (last, line, index) => (/^›(?:\s|$)/.test(line) ? index : last),
      -1,
    );
    if (
      prompt < 0 ||
      !lines.slice(prompt + 1).some((l) => /^\s{2,}.*(?:Context|% left|shortcuts)/i.test(l))
    )
      return "unsupported";
    return /^(?:›\s*|› Ask Codex to do anything)$/.test(lines[prompt]) && !lines[prompt + 1]?.trim()
      ? "empty"
      : "draft";
  }
  const borders = lines.flatMap((l, i) => (/^\s*─{3,}\s*$/.test(l) ? [i] : []));
  const bottom = borders.at(-1);
  const top = borders.at(-2);
  if (top === undefined || bottom === undefined || bottom <= top + 1) return "unsupported";
  const input = lines.slice(top + 1, bottom);
  if (
    !/^[>❯](?:[ \u00a0]|$)/.test(input[0]) ||
    input.slice(1).some((l) => /^(?:>|❯|│|╭|╰)/.test(l))
  )
    return "unsupported";
  return /^(?:[>❯]\s*|[>❯]\s*Try ".*")$/.test(input[0]) && input.slice(1).every((l) => !l.trim())
    ? "empty"
    : "draft";
}

/** Paired deletion works from the middle of a multiline draft without Ctrl+C. */
export async function prepareAgentClear(
  id: string,
  provider: Provider,
  write: (text: string) => Promise<void>,
  current: () => boolean,
  deadline: number,
  submit: () => Promise<void> = async () => {},
): Promise<void> {
  if (pending.has(id)) throw new Error("Agent clear is already in progress");
  pending.add(id);
  try {
    const inspect = () => {
      if (!current() || Date.now() >= deadline)
        throw new Error("Agent clear scope changed or timed out");
      const screen = getTerminalInspector(id)?.(0);
      if (!screen || agentClearComposer(screen, provider) === "unsupported")
        throw new Error("Agent clear needs a supported idle text composer");
      return screen;
    };
    inspect();
    // Always delete once: a typed placeholder string cannot authorize append.
    let emptySince: number | undefined;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const screen = inspect();
      if (round > 0 && agentClearComposer(screen, provider) === "empty") {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 180) {
          await submit();
          return;
        }
      } else {
        emptySince = undefined;
        await write(DELETE_BATCH);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error("Agent clear could not verify an empty composer");
  } finally {
    pending.delete(id);
  }
}
