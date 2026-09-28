import { invoke } from "@tauri-apps/api/core";
import {
  getTerminalInspector,
  getTerminalRenderCheckpointProvider,
  type TerminalBufferDump,
} from "./terminal-serialize-registry";
import type { TerminalRenderCheckpointTarget } from "./terminal-render-checkpoint";
import { acquireCheckpointGeometry, type CheckpointGeometry } from "./terminal-checkpoint-geometry";
import { formatCodexCheckpointError } from "./codex-checkpoint-error";

const POLL_MS = 60;
const TARGET_TIMEOUT_MS = 8_000;
const SCREEN_SETTLE_MS = 180;
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
  const footer = lines
    .slice(prompt + 1)
    .filter((line) => line.trim())
    .slice(-2);
  return footer.some(
    (line) =>
      /(?:^\s{2,}|\|\s*)Vim: (?:Normal|Insert|Replace)(?:\s*\||\s*$)/.test(line) ||
      /\b(?:enter|esc)\s+(?:select|confirm|continue|back|cancel)\b/i.test(line),
  );
}

export function isCodexIdleTextComposer(screen: TerminalBufferDump): boolean {
  const lines = visibleLines(screen);
  return !unsupported(lines) && lines.some((line) => line.startsWith("› "));
}

export function isCodexEmptyTextComposer(screen: TerminalBufferDump): boolean {
  if (!isCodexIdleTextComposer(screen)) return false;
  const lines = visibleLines(screen);
  const prompt = lines.reduce((last, line, index) => (line.startsWith("›") ? index : last), -1);
  return (
    /^(?:›\s*|› Ask Codex to do anything)$/.test(lines[prompt] ?? "") && !lines[prompt + 1]?.trim()
  );
}

export function isCodexDismissibleMenu(screen: TerminalBufferDump): boolean {
  const lines = visibleLines(screen);
  if (lines.some((line) => UNSUPPORTED.test(line))) return false;
  const footer = lines
    .filter((line) => line.trim())
    .slice(-2)
    .join(" ");
  return (
    /esc\s+(?:to\s+)?(?:cancel|back)/i.test(footer) &&
    lines.some((line) => /^\s*(?:Select Model and Effort|Update Model Permissions)\s*$/.test(line))
  );
}

export function isCodexStatusCommandSelected(screen: TerminalBufferDump): boolean {
  const lines = visibleLines(screen);
  if (unsupported(lines)) return false;
  const prompt = lines.reduce((last, line, index) => (line.startsWith("› ") ? index : last), -1);
  if (prompt < 0 || !/^› \/status?$/.test(lines[prompt]) || lines[prompt + 1]?.trim()) return false;
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
  stage: string,
): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Codex /status verification timed out (${stage}); close/update was cancelled`);
}

async function probeTerminal(
  token: string,
  target: CheckpointGeometry & { terminalId: string },
  releases: (() => void)[],
): Promise<void> {
  const { terminalId } = target;
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  const input = (step: "dismiss" | "clear" | "typeStatus" | "submit") =>
    invoke<TerminalRenderCheckpointTarget | null>("codex_status_checkpoint_input", {
      token,
      terminalId,
      step,
    });
  if (isCodexDismissibleMenu(inspect(terminalId))) {
    await input("dismiss");
    await waitFor(
      () => (isCodexIdleTextComposer(inspect(terminalId)) ? true : undefined),
      deadline,
      "menu dismissal",
    );
  }
  if (!isCodexIdleTextComposer(inspect(terminalId))) {
    throw new Error(
      `Codex status: ${terminalId} needs an idle text composer with the default keymap`,
    );
  }
  const original = inspect(terminalId);
  releases.push(acquireCheckpointGeometry(terminalId, target, original));
  // Wait for the sequenced geometry/repaint before adding the command. A small
  // pane otherwise clips the UUID in Codex's status card, not merely in xterm.
  await waitFor(
    () => {
      const screen = inspect(terminalId);
      return screen.cols === target.cols && screen.rows === target.rows ? true : undefined;
    },
    deadline,
    "terminal resize",
  );
  await input("clear");
  await waitFor(
    async () => {
      if (isCodexEmptyTextComposer(inspect(terminalId))) return true;
      await input("clear");
      return undefined;
    },
    deadline,
    "draft deletion",
  );
  await input("typeStatus");
  await waitFor(
    () => (isCodexStatusCommandSelected(inspect(terminalId)) ? true : undefined),
    deadline,
    "status command selection",
  );
  const submitted = await input("submit");
  if (!submitted) throw new Error("Codex status: submission boundary is unavailable");
  const provider = getTerminalRenderCheckpointProvider(terminalId);
  if (!provider) throw new Error("Codex status: current terminal screen is unavailable");
  let previousScreen = "";
  let settledAt = Date.now();
  await waitFor(
    async () => {
      // A zero scrollback budget captures the complete live viewport. Unchanged
      // cells (including the UUID) are retained by the existing xterm model.
      const screen = await provider({ ...submitted, seq: submitted.seq + 1 }, 0);
      const signature = JSON.stringify(screen);
      if (signature !== previousScreen) {
        previousScreen = signature;
        settledAt = Date.now();
        return undefined;
      }
      if (Date.now() - settledAt < SCREEN_SETTLE_MS) return undefined;
      const id = await invoke<string | null>("read_codex_status_checkpoint", {
        token,
        terminalId,
        screen,
      });
      return id ?? undefined;
    },
    deadline,
    "status response",
  );
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
  }>("begin_codex_status_checkpoint", { updateRequestId }).catch((error: unknown) => {
    throw formatCodexCheckpointError(error);
  });
  const releases: (() => void)[] = [];
  try {
    // Drain every started query before releasing the token, including failures.
    const results = await Promise.allSettled(
      targets.map(async (target) => {
        try {
          await probeTerminal(token, target, releases);
        } catch (error) {
          throw new Error(
            `[${target.terminalId}] ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    if (failures.length) throw formatCodexCheckpointError(failures.join("\n"));
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
