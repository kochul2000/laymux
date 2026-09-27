import { invoke } from "@tauri-apps/api/core";
import { getTerminalInspector, type TerminalBufferDump } from "./terminal-serialize-registry";
import { acquireCheckpointGeometry, type CheckpointGeometry } from "./terminal-checkpoint-geometry";

const POLL_MS = 60;
const TARGET_TIMEOUT_MS = 8_000;
const UNSUPPORTED =
  /Preparing images:|esc to interrupt|Reconnecting|Task is still running|\[Image\s*#?\d|queued message/i;

function visibleLines(screen: TerminalBufferDump): string[] {
  return screen.lines
    .filter((line) => line.index >= screen.baseY)
    .map((line) => line.text.trimEnd());
}

function unsupported(lines: string[]): boolean {
  if (lines.some((line) => UNSUPPORTED.test(line))) return true;
  const prompt = lines.reduce((last, line, index) => (line.startsWith("› ") ? index : last), -1);
  return lines
    .slice(prompt + 1)
    .filter((line) => line.trim())
    .slice(-2)
    .some((line) => /(?:^\s{2,}|\|\s*)Vim: (?:Normal|Insert|Replace)(?:\s*\||\s*$)/.test(line));
}

export function isCodexIdleTextComposer(screen: TerminalBufferDump): boolean {
  const lines = visibleLines(screen);
  return !unsupported(lines) && lines.some((line) => line.startsWith("› "));
}

export function isCodexStatusCommandSelected(screen: TerminalBufferDump): boolean {
  const lines = visibleLines(screen);
  if (unsupported(lines)) return false;
  const prompt = lines.reduce((last, line, index) => (line.startsWith("› ") ? index : last), -1);
  if (prompt < 0 || lines[prompt] !== "› /status" || lines[prompt + 1]?.trim()) return false;
  // The selected popup entry dispatches the builtin; text after the slash name
  // is never accepted as proof. Looking only for '/status' in scrollback would
  // allow an old card or a user's quoted prompt to authorize Enter.
  return lines
    .slice(Math.max(0, prompt - 6), prompt)
    .some((line) => /^› \/status\s+show current session configuration/.test(line));
}

function inspect(id: string): TerminalBufferDump {
  const inspector = getTerminalInspector(id);
  if (!inspector) throw new Error(`Codex status: terminal screen is unavailable for ${id}`);
  return inspector(200);
}

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  deadline: number,
): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Codex /status verification timed out; close/update was cancelled");
}

async function probeTerminal(
  token: string,
  target: CheckpointGeometry & { terminalId: string },
  releases: (() => void)[],
): Promise<void> {
  const { terminalId } = target;
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  if (!isCodexIdleTextComposer(inspect(terminalId))) {
    throw new Error(
      `Codex status: ${terminalId} needs an idle text composer with the default keymap`,
    );
  }
  const input = (step: "clear" | "typeStatus" | "submit") =>
    invoke<void>("codex_status_checkpoint_input", { token, terminalId, step });
  const original = inspect(terminalId);
  releases.push(acquireCheckpointGeometry(terminalId, target, original));
  // Wait for the sequenced geometry/repaint before adding the command. A small
  // pane otherwise clips the UUID in Codex's status card, not merely in xterm.
  await waitFor(() => {
    const screen = inspect(terminalId);
    return screen.cols === target.cols && screen.rows === target.rows ? true : undefined;
  }, deadline);
  await input("clear");
  await input("typeStatus");
  await waitFor(
    () => (isCodexStatusCommandSelected(inspect(terminalId)) ? true : undefined),
    deadline,
  );
  await input("submit");
  await waitFor(async () => {
    const id = await invoke<string | null>("read_codex_status_checkpoint", { token, terminalId });
    return id ?? undefined;
  }, deadline);
}

/** Lifecycle token remains separate from merged background checkpoint reasons. */
export async function withCodexStatusCheckpoint<T>(
  enabled: boolean,
  updateRequestId: number | undefined,
  checkpoint: () => Promise<T>,
): Promise<T> {
  if (!enabled) return checkpoint();
  const { token, targets } = await invoke<{
    token: string;
    targets: (CheckpointGeometry & { terminalId: string })[];
  }>("begin_codex_status_checkpoint", { updateRequestId });
  const releases: (() => void)[] = [];
  try {
    // Drain every started query before releasing the token, including failures.
    const results = await Promise.allSettled(
      targets.map((target) => probeTerminal(token, target, releases)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const result = await checkpoint();
    // A delayed save must not succeed after the proof's deadline. Successful
    // close keeps native admission fenced until the window is destroyed.
    await invoke("complete_codex_status_checkpoint", { token });
    return result;
  } finally {
    try {
      await invoke("finish_codex_status_checkpoint", { token });
    } finally {
      for (const release of releases) release();
    }
  }
}
